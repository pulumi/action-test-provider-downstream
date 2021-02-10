"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const exec_1 = require("@actions/exec");
const github = __importStar(require("@actions/github"));
const path = __importStar(require("path"));
function find_gopath() {
    return __awaiter(this, void 0, void 0, function* () {
        let output = "";
        const options = {
            listeners: {
                stdline: (data) => output += data,
            }
        };
        yield exec_1.exec("go", ["env", "GOPATH"], options);
        return output.trim();
    });
}
function find_commit_sha(path, offset = 0) {
    return __awaiter(this, void 0, void 0, function* () {
        let output = "";
        const options = {
            cwd: path,
            listeners: {
                stdline: (data) => output += data,
            }
        };
        yield exec_1.exec("git", ["rev-parse", "--short", `HEAD${offset > 0 ? `~${offset}` : ""}`], options);
        return output.trim();
    });
}
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const upstream = core.getInput("upstream") || "pulumi-terraform-bridge";
            const checkoutSHA = process.env.GITHUB_SHA;
            const branchName = `integration/${upstream}/${checkoutSHA}`;
            const isPrivateRepo = core.getInput("is-private-repo");
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
            let hasPulumiBotToken = false;
            const pulumiBotToken = core.getInput("pulumi-bot-token");
            if (pulumiBotToken != undefined && pulumiBotToken != "") {
                core.setSecret(pulumiBotToken);
                hasPulumiBotToken = true;
            }
            // Ensure that the GitHub Actions token is available
            let hasGitHubActionsToken = false;
            const githubActionsToken = core.getInput("github-actions-token");
            if (githubActionsToken != undefined && githubActionsToken != "") {
                core.setSecret(githubActionsToken);
                hasGitHubActionsToken = true;
            }
            const gopathBin = path.join(yield find_gopath(), "bin");
            const newPath = `${gopathBin}:${process.env.PATH}`;
            const parentDir = path.resolve(process.cwd(), "..");
            let downstreamRepo = core.getInput("downstream-url");
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
            if (isPrivateRepo != undefined && isPrivateRepo != "") {
                downstreamRepo = `https://${pulumiBotToken}@github.com/${downstreamRepo}`;
            }
            yield exec_1.exec("git", ["clone", downstreamRepo, downstreamDir]);
            yield exec_1.exec("git", ["checkout", "-b", branchName], inDownstreamOptions);
            yield exec_1.exec("git", ["config", "user.name", gitUser], inDownstreamOptions);
            yield exec_1.exec("git", ["config", "user.email", gitEmail], inDownstreamOptions);
            for (const replace of replacements) {
                const replacePath = path.join(relativeRoot, "..", replace.with);
                core.info(`replacing ${replace.module} with ${replace.with} @ ${replacePath}`);
                yield exec_1.exec("go", ["mod", "edit", `-replace=${replace.module}=${replacePath}`], inDownstreamModOptions);
            }
            yield exec_1.exec("go", ["mod", "download"], inDownstreamModOptions);
            yield exec_1.exec("git", ["commit", "-a", "-m", `Replace ${upstream} module`], inDownstreamOptions);
            yield exec_1.exec("make", ["only_build"], inDownstreamOptions);
            yield exec_1.exec("git", ["add", "."], inDownstreamOptions);
            yield exec_1.exec("git", ["commit", "--allow-empty", "-m", `Update to ${upstream}@${checkoutSHA}`], inDownstreamOptions);
            if (hasPulumiBotToken && hasGitHubActionsToken) {
                const url = `https://pulumi-bot:${pulumiBotToken}@github.com/pulumi-bot/${downstreamName}`;
                yield exec_1.exec("git", ["remote", "add", "pulumi-bot", url], inDownstreamOptions);
                yield exec_1.exec("git", ["push", "pulumi-bot", "--set-upstream", "--force", branchName], inDownstreamOptions);
                const newCommitSha = yield find_commit_sha(downstreamDir, 0);
                const oldCommitSha = yield find_commit_sha(downstreamDir, 1);
                const diffUrl = `https://github.com/pulumi-bot/${downstreamName}/compare/${oldCommitSha}..${newCommitSha}`;
                const client = new github.GitHub(githubActionsToken);
                yield client.issues.createComment({
                    owner: github.context.issue.owner,
                    repo: github.context.issue.repo,
                    issue_number: github.context.issue.number,
                    body: `Diff for [${downstreamName}](${diffUrl}) with merge commit ${checkoutSHA}`,
                });
            }
            else {
                yield exec_1.exec("git", ["show"], inDownstreamOptions);
            }
        }
        catch (error) {
            core.setFailed(error.message);
        }
    });
}
run();
