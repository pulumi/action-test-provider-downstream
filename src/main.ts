import * as core from "@actions/core";
import {exec} from "@actions/exec";
import * as github from "@actions/github";
import * as path from "path";
import {issue} from "@actions/core/lib/command";

async function find_gopath(): Promise<string> {
    let output = "";
    const options = {
        listeners: {
            stdline: (data) => output += data,
        }
    };

    await exec("go", ["env", "GOPATH"], options);

    return output.trim();
}

async function find_commit_sha(path: string, offset: number = 0): Promise<string> {
    let output = "";
    const options = {
        cwd: path,
        listeners: {
            stdline: (data) => output += data,
        }
    };

    await exec("git", ["rev-parse", "--short", `HEAD${offset > 0 ? `~${offset}` : ""}`], options);

    return output.trim();
}

interface replacement {
    module: string;
    with: string;
}

async function run() {
    try {
        const upstream = core.getInput("upstream") || "pulumi-terraform-bridge";
        const checkoutSHA = process.env.GITHUB_SHA;
        const branchName = `integration/${upstream}/${checkoutSHA}`;

        // we want to allow the user to be able to pass an issue-number to comment on
        let issueNumber = github.context.issue.number;
        let userDefinedIssue = core.getInput("issue-number");
        if (userDefinedIssue != undefined && userDefinedIssue != "") {
            issueNumber = Number(userDefinedIssue)
        }

        const replacementsStr = core.getInput("replacements") || "github.com/pulumi/pulumi-terraform-bridge/v2=pulumi-terraform-bridge";
        const replacements: replacement[] = [];
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

        const gopathBin = path.join(await find_gopath(), "bin");
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
            env: {
                ...process.env,
                PATH: newPath,
            },
        };

        const inDownstreamModOptions = {
            ...inDownstreamOptions,
            cwd: downstreamModDirFull,
        };

        await exec("git", ["clone", downstreamRepo, downstreamDir]);

        await exec("git", ["checkout", "-b", branchName], inDownstreamOptions);
        await exec("git", ["config", "user.name", gitUser], inDownstreamOptions);
        await exec("git", ["config", "user.email", gitEmail], inDownstreamOptions);

        for (const replace of replacements) {
            const replacePath = path.join(relativeRoot, "..", replace.with);
            core.info(`replacing ${replace.module} with ${replace.with} @ ${replacePath}`);

            await exec("go", ["mod", "edit", `-replace=${replace.module}=${replacePath}`], inDownstreamModOptions);
        }
        await exec("go", ["mod", "download"], inDownstreamModOptions);
        await exec("git", ["commit", "-a", "-m", `Replace ${upstream} module`], inDownstreamOptions);

        await exec("make", ["only_build"], inDownstreamOptions);

        await exec("git", ["add", "."], inDownstreamOptions);
        await exec("git", ["commit", "--allow-empty", "-m", `Update to ${upstream}@${checkoutSHA}`], inDownstreamOptions);

        if (hasPulumiBotToken && hasGitHubActionsToken) {
            const url = `https://pulumi-bot:${pulumiBotToken}@github.com/pulumi-bot/${downstreamName}`;

            await exec("git", ["remote", "add", "pulumi-bot", url], inDownstreamOptions);
            await exec("git", ["push", "pulumi-bot", "--set-upstream", "--force", branchName], inDownstreamOptions);

            const newCommitSha = await find_commit_sha(downstreamDir, 0);
            const oldCommitSha = await find_commit_sha(downstreamDir, 1);

            const diffUrl = `https://github.com/pulumi-bot/${downstreamName}/compare/${oldCommitSha}..${newCommitSha}`;

            const client = new github.GitHub(githubActionsToken);

            await client.issues.createComment({
                owner: github.context.issue.owner,
                repo: github.context.issue.repo,
                issue_number: issueNumber,
                body: `Diff for [${downstreamName}](${diffUrl}) with merge commit ${checkoutSHA}`,
            });
        } else {
            await exec("git", ["show"], inDownstreamOptions);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
