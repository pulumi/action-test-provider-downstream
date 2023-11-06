"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const exec_1 = require("@actions/exec");
const io = __importStar(require("@actions/io"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
function find_gopath() {
    return __awaiter(this, void 0, void 0, function* () {
        let output = "";
        const options = {
            listeners: {
                stdline: (data) => (output += data),
            },
        };
        yield (0, exec_1.exec)("go", ["env", "GOPATH"], options);
        return output.trim();
    });
}
function find_commit_sha(path, offset = 0) {
    return __awaiter(this, void 0, void 0, function* () {
        let output = "";
        const options = {
            cwd: path,
            listeners: {
                stdline: (data) => (output += data),
            },
        };
        yield (0, exec_1.exec)("git", ["rev-parse", "--short", `HEAD${offset > 0 ? `~${offset}` : ""}`], options);
        return output.trim();
    });
}
function run() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const upstream = core.getInput("upstream") || "pulumi-terraform-bridge";
            const checkoutSHA = process.env.GITHUB_SHA;
            const branchName = `integration/${upstream}/${checkoutSHA}`;
            const replacementsStr = core.getInput("replacements") || "github.com/pulumi/pulumi-terraform-bridge/v2=pulumi-terraform-bridge";
            const replacements = [];
            for (const replaceStr of replacementsStr.split(",")) {
                const [replaceModule, replaceWith] = replaceStr.split("=", 2);
                replacements.push({ module: replaceModule, with: replaceWith });
            }
            let gomodPath = core.getInput("go-mod-path") || "go.mod";
            const gitUser = "Pulumi Bot";
            const gitEmail = "bot@pulumi.com";
            const useProviderDir = core.getInput("use-provider-dir") == "true";
            if (useProviderDir) {
                gomodPath = "provider/go.mod";
            }
            // Ensure that the bot token is masked in the log output
            let hasPullRequestToken = false;
            const pullRequestToken = (_a = core.getInput("GITHUB_TOKEN")) !== null && _a !== void 0 ? _a : core.getInput("pulumi-bot-token");
            if (pullRequestToken != undefined && pullRequestToken != "") {
                core.setSecret(pullRequestToken);
                hasPullRequestToken = true;
            }
            const gopathBin = path.join(yield find_gopath(), "bin");
            const newPath = `${gopathBin}:${process.env.PATH}`;
            const parentDir = path.resolve(process.cwd(), "..");
            const downstreamRepo = core.getInput("downstream-url");
            const downstreamName = core.getInput("downstream-name");
            const downstreamDir = path.join(parentDir, downstreamName);
            const downstreamModDirFull = path.dirname(path.join(downstreamDir, gomodPath));
            const relativeRoot = path.relative(downstreamModDirFull, downstreamDir);
            core.info(`go.mod @ ${gomodPath}`);
            const inDownstreamOptions = {
                cwd: downstreamDir,
                env: Object.assign(Object.assign({}, process.env), { PATH: newPath }),
            };
            const inDownstreamModOptions = Object.assign(Object.assign({}, inDownstreamOptions), { cwd: downstreamModDirFull });
            yield (0, exec_1.exec)("git", ["clone", "--quiet", downstreamRepo, downstreamDir]);
            yield (0, exec_1.exec)("git", ["submodule", "update", "--init", "--recursive"], inDownstreamOptions);
            yield (0, exec_1.exec)("git", ["checkout", "-b", branchName], inDownstreamOptions);
            yield (0, exec_1.exec)("git", ["config", "user.name", gitUser], inDownstreamOptions);
            yield (0, exec_1.exec)("git", ["config", "user.email", gitEmail], inDownstreamOptions);
            for (const replace of replacements) {
                const replacePath = path.join(relativeRoot, "..", replace.with);
                core.info(`replacing ${replace.module} with ${replace.with} @ ${replacePath}`);
                yield (0, exec_1.exec)("go", ["mod", "edit", `-replace=${replace.module}=${replacePath}`], inDownstreamModOptions);
            }
            console.log("::group::go mod tidy");
            yield (0, exec_1.exec)("go", ["mod", "tidy", "-compat=1.17"], inDownstreamModOptions);
            console.log("::endgroup::");
            yield (0, exec_1.exec)("git", ["commit", "-a", "-m", `Replace ${upstream} module`], inDownstreamOptions);
            const summaryDir = `${downstreamDir}/summary`;
            yield io.mkdirP(summaryDir);
            //// Delete old sdk's to prevent un-deleted files error-ing compilation.
            //const sdkDir = `${downstreamDir}/sdk`;
            //console.log(`Deleting ${sdkDir}/LANG folders`);
            //fs.readdirSync(sdkDir).filter(f => fs.statSync(`${sdkDir}/${f}`).isDirectory())
            //    .forEach(dir => {
            //    fs.rmSync(`${sdkDir}/${dir}`, { recursive: true, force: true });
            //});
            try {
                // Try to make upstream if it exists.
                yield (0, exec_1.exec)("make", ["upstream"], inDownstreamOptions);
            }
            catch (e) {
            }
            console.log("::group::make only_build");
            yield (0, exec_1.exec)("make", ["only_build"], Object.assign(Object.assign({}, inDownstreamOptions), { env: Object.assign(Object.assign({}, inDownstreamOptions.env), { COVERAGE_OUTPUT_DIR: summaryDir }) }));
            console.log("::endgroup::");
            try {
                const f = fs.readFileSync(`${summaryDir}/summary.json`);
                const json = JSON.parse(f.toString());
                const fatals = json.Fatals.Number;
                if (fatals > 0) {
                    if (core.getBooleanInput("enforce-fatal", { required: false }))
                        core.setFailed(`Found ${fatals} fatal errors during codegen`);
                    else
                        core.warning("${fatals} examples crashed codegen");
                    delete json["ConversionErrors"];
                    core.summary.addRaw(json);
                }
            }
            catch (err) {
                // Not all providers have a summary, so if no file gets generated, we do nothing
                if (err instanceof Error) {
                    const e = err;
                    if (e.code !== 'ENOENT') {
                        throw err;
                    }
                    else {
                        console.log("No summary found.");
                    }
                    ;
                }
            }
            yield (0, exec_1.exec)("git", ["add", "."], inDownstreamOptions);
            yield (0, exec_1.exec)("git", ["commit", "--allow-empty", "-m", `Update to ${upstream}@${checkoutSHA}`], inDownstreamOptions);
            if (hasPullRequestToken) {
                const url = `https://pulumi-bot:${pullRequestToken}@github.com/pulumi-bot/${downstreamName}`;
                yield (0, exec_1.exec)("git", ["remote", "add", "pulumi-bot", url], inDownstreamOptions);
                yield (0, exec_1.exec)("git", ["push", "pulumi-bot", "--set-upstream", "--force", branchName], inDownstreamOptions);
                const newCommitSha = yield find_commit_sha(downstreamDir, 0);
                const oldCommitSha = yield find_commit_sha(downstreamDir, 1);
                const diffUrl = `https://github.com/pulumi-bot/${downstreamName}/compare/${oldCommitSha}..${newCommitSha}`;
                // Write to summary markdown file for workflow.
                core.summary.addRaw(`Diff for [${downstreamName}](${diffUrl}) with merge commit ${checkoutSHA}\n`).write();
            }
            else {
                yield (0, exec_1.exec)("git", ["show"], inDownstreamOptions);
            }
        }
        catch (error) {
            if (error instanceof Error) {
                core.setFailed(error.message);
            }
            else {
                core.setFailed(`Unhandled exception: ${error}`);
            }
        }
    });
}
run();
