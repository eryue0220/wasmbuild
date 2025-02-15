// Copyright 2018-2024 the Deno authors. MIT license.

import type { BuildCommand, CheckCommand } from "./args.ts";
import * as colors from "@std/fmt/colors";
import * as path from "@std/path";
import { Sha1 } from "./utils/sha1.ts";
import { getCargoWorkspace, type WasmCrate } from "./manifest.ts";
import { verifyVersions } from "./versions.ts";
import { type BindgenOutput, generateBindgen } from "./bindgen.ts";
import { pathExists } from "./helpers.ts";
export type { BindgenOutput } from "./bindgen.ts";

const generatedHeader = `// @generated file from wasmbuild -- do not edit
// @ts-nocheck: generated
// deno-lint-ignore-file
// deno-fmt-ignore-file`;

export interface PreBuildOutput {
  bindgen: BindgenOutput;
  bindingJs: {
    path: string;
    text: string;
  };
  bindingJsBg: {
    path: string;
    text: string;
  };
  bindingDts: {
    path: string;
    text: string;
  };
  sourceHash: string;
  wasmFileName: string | undefined;
}

export async function runPreBuild(
  args: CheckCommand | BuildCommand,
): Promise<PreBuildOutput> {
  const home = Deno.env.get("HOME");
  const root = Deno.cwd();
  if (!await pathExists(path.join(root, "Cargo.toml"))) {
    console.error(
      "%cConsider running `deno task wasmbuild new` to get started",
      "color: yellow",
    );
    throw `Cargo.toml not found in ${root}`;
  }
  const workspace = await getCargoWorkspace(root, args.cargoFlags);
  const crate = workspace.getWasmCrate(args.project);

  verifyVersions(crate);

  try {
    const rustupAddWasm = new Deno.Command("rustup", {
      args: ["target", "add", "wasm32-unknown-unknown"],
    });
    console.log(
      `${
        colors.bold(colors.green("Ensuring"))
      } wasm32-unknown-unknown target installed...`,
    );
    const rustupAddWasmOutput = await rustupAddWasm.output();
    if (!rustupAddWasmOutput.success) {
      console.error(`adding wasm32-unknown-unknown target failed`);
      Deno.exit(1);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.info(
        `rustup not found. Ensure wasm32-unknown-unknown installed manually.`,
      );
    } else {
      throw error;
    }
  }

  console.log(
    `${colors.bold(colors.green("Building"))} ${crate.name} WebAssembly...`,
  );

  const cargoBuildCmd = [
    "build",
    "--lib",
    "-p",
    crate.name,
    "--target",
    "wasm32-unknown-unknown",
    ...args.cargoFlags,
  ];

  if (args.profile === "release") {
    cargoBuildCmd.push("--release");
  }

  const CARGO_ENCODED_RUSTFLAGS = [
    ...(
      Deno.env.get("CARGO_ENCODED_RUSTFLAGS")?.split("\x1f") ??
        Deno.env.get("RUSTFLAGS")?.split(" ") ??
        []
    ),
    `--remap-path-prefix=${root}=.`,
    `--remap-path-prefix=${home}=~`,
  ].join("\x1f");

  console.log(`  ${colors.bold(colors.gray(cargoBuildCmd.join(" ")))}`);
  const cargoBuildReleaseCmdProcess = new Deno.Command("cargo", {
    args: cargoBuildCmd,
    env: {
      "SOURCE_DATE_EPOCH": "1600000000",
      "TZ": "UTC",
      "LC_ALL": "C",
      CARGO_ENCODED_RUSTFLAGS,
    },
  }).spawn();
  const cargoBuildReleaseCmdOutput = await cargoBuildReleaseCmdProcess.status;
  if (!cargoBuildReleaseCmdOutput.success) {
    console.error(`cargo build failed`);
    Deno.exit(1);
  }

  console.log(`  ${colors.bold(colors.gray("Running wasm-bindgen..."))}`);
  const bindgenOutput = await generateBindgen({
    libName: crate.libName,
    ext: args.bindingJsFileExt,
    filePath: path.join(
      workspace.metadata.target_directory,
      `wasm32-unknown-unknown/${args.profile}/${crate.libName}.wasm`,
    ),
  });

  console.log(
    `${colors.bold(colors.green("Generating"))} lib JS bindings...`,
  );

  const { bindingJsText, sourceHash } = await getBindingJsOutput(
    crate,
    bindgenOutput,
  );

  return {
    bindgen: bindgenOutput,
    bindingJs: {
      path: path.join(args.outDir, bindgenOutput.js.name),
      text: bindingJsText,
    },
    bindingJsBg: {
      path: path.join(args.outDir, bindgenOutput.jsBg.name),
      text: `${generatedHeader}\n\n${await getFormattedText(
        bindgenOutput.jsBg.text,
      )}`,
    },
    bindingDts: {
      path: path.join(args.outDir, bindgenOutput.ts.name),
      text: `// @generated file from wasmbuild -- do not edit
// deno-lint-ignore-file
// deno-fmt-ignore-file

${await getFormattedText(getLibraryDts(bindgenOutput))}`,
    },
    sourceHash,
    wasmFileName: bindgenOutput.wasm.name,
  };
}

async function getBindingJsOutput(
  crate: WasmCrate,
  bindgenOutput: BindgenOutput,
) {
  const sourceHash = await getHash();
  const header = `${generatedHeader}
// @ts-self-types="./${bindgenOutput.ts.name}"
`;
  const genText = bindgenOutput.js.text;
  const bodyText = await getFormattedText(`
// source-hash: ${sourceHash}
${genText}
`);

  return {
    bindingJsText: `${header}\n${bodyText}`,
    sourceHash,
  };

  async function getHash() {
    // Create a hash of all the sources, snippets, and local modules
    // in order to tell when the output has changed.
    const hasher = new Sha1();
    const sourceHash = await crate.getSourcesHash();
    hasher.update(sourceHash);
    for (const [identifier, list] of Object.entries(bindgenOutput.snippets)) {
      hasher.update(identifier);
      for (const text of list) {
        hasher.update(text.replace(/\r?\n/g, "\n"));
      }
    }
    for (const [name, text] of Object.entries(bindgenOutput.localModules)) {
      hasher.update(name);
      hasher.update(text.replace(/\r?\n/g, "\n"));
    }
    return hasher.hex();
  }
}

async function getFormattedText(inputText: string) {
  const denoFmtCmdArgs = [
    "fmt",
    "--quiet",
    "--ext",
    "ts",
    "-",
  ];
  console.log(`  ${colors.bold(colors.gray(denoFmtCmdArgs.join(" ")))}`);
  const denoFmtCmd = new Deno.Command(Deno.execPath(), {
    args: denoFmtCmdArgs,
    stdin: "piped",
    stdout: "piped",
  });
  const denoFmtChild = denoFmtCmd.spawn();
  const stdin = denoFmtChild.stdin.getWriter();
  await stdin.write(new TextEncoder().encode(inputText));
  await stdin.close();

  const output = await denoFmtChild.output();
  if (!output.success) {
    console.error("deno fmt command failed");
    Deno.exit(1);
  }
  return new TextDecoder().decode(output.stdout);
}

function getLibraryDts(bindgenOutput: BindgenOutput) {
  return bindgenOutput.ts.text.replace(
    `/* tslint:disable */
/* eslint-disable */
`,
    "",
  );
}
