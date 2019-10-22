import * as core from "@actions/core";
import * as github from "@actions/github";
import {exec} from "@actions/exec";
import * as path from "path";

const replace = "github.com/pulumi/pulumi-terraform-bridge";
const replaceWith = "../pulumi-terraform-bridge";
const gitUser = "Pulumi Bot";
const gitEmail = "bot@pulumi.com";

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

async function run() {
    try {
        const checkoutSHA = process.env.GITHUB_SHA;
        const branchName = `integration/pulumi-terraform-bridge/${checkoutSHA}`;

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

        const inDownstreamOptions = {
            cwd: downstreamDir,
            env: {
                ...process.env,
                PATH: newPath,
            },
        };

        await exec("git", ["clone", downstreamRepo, downstreamDir]);

        await exec("git", ["checkout", "-b", branchName], inDownstreamOptions);
        await exec("git", ["config", "user.name", gitUser], inDownstreamOptions);
        await exec("git", ["config", "user.email", gitEmail], inDownstreamOptions);

        await exec("go", ["mod", "edit", `-replace=${replace}=${replaceWith}`], inDownstreamOptions);
        await exec("go", ["mod", "download"], inDownstreamOptions);
        await exec("git", ["commit", "-a", "-m", "Replace pulumi-terraform-bridge module"], inDownstreamOptions);

        await exec("make", ["only_build"], inDownstreamOptions);

        await exec("git", ["add", "."], inDownstreamOptions);
        await exec("git", ["commit", "--allow-empty", "-m", `Update to pulumi-terraform-bridge@${checkoutSHA}`], inDownstreamOptions);

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
                issue_number: github.context.issue.number,
                body: `Diff for [${downstreamName}](${diffUrl}) with commit ${checkoutSHA}`,
            });
        } else {
            await exec("git", ["show"], inDownstreamOptions);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
