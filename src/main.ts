import * as core from "@actions/core";
import {exec} from "@actions/exec";
import * as github from "@actions/github";
import * as path from "path";

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
        const gitUser = "Pulumi Bot";
        const gitEmail = "bot@pulumi.com";

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

        // Check if this is a downstream test or a PR
        const openPullRequest = core.getInput("open-pull-request") == "true";

        let gomodPath = core.getInput("go-mod-path") || "go.mod";
        const useProviderDir = core.getInput("use-provider-dir") == "true";
        if (useProviderDir) {
            gomodPath = "provider/go.mod";
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

        const replacementsStr = core.getInput("replacements") || "github.com/pulumi/pulumi-terraform-bridge/v2=pulumi-terraform-bridge";
        const replacements: replacement[] = [];
        for (const replaceStr of replacementsStr.split(",")) {
            const [replaceModule, replaceWith] = replaceStr.split("=", 2);
            replacements.push({module: replaceModule, with: replaceWith});
        }
        if (!openPullRequest) {
            for (const replace of replacements) {
                const replacePath = path.join(relativeRoot, "..", replace.with);
                core.info(`replacing ${replace.module} with ${replace.with} @ ${replacePath}`);

                await exec("go", ["mod", "edit", `-replace=${replace.module}=${replacePath}`], inDownstreamModOptions);
            }
        } else {
            for (const replace of replacements) {
                await exec("go", ["mod", "edit", `-require=${replace.module}@${checkoutSHA}`], inDownstreamModOptions);
            }
        }

        // Prepare the go.mod file
        await exec("go", ["mod", "download"], inDownstreamModOptions);

        if (openPullRequest) {
            await exec("go", ["mod", "tidy"], inDownstreamModOptions);
        }
        await exec("git", ["commit", "-a", "-m", `Replace ${upstream} module`], inDownstreamOptions);

        // Run the build
        await exec("make", ["only_build"], inDownstreamOptions);

        const buildChanges = await exec("git", ["diff", "--stat"], inDownstreamOptions)
        core.info(`hasChanges @ ${buildChanges}`);

        // Commit the results
        await exec("git", ["add", "."], inDownstreamOptions);
        await exec("git", ["commit", "--allow-empty", "-m", `Update to ${upstream}@${checkoutSHA}`], inDownstreamOptions);

        if (hasPulumiBotToken && hasGitHubActionsToken) {
            const client = new github.GitHub(githubActionsToken);

            await exec("git", ["push", "origin", branchName], inDownstreamOptions);

            if (openPullRequest) {
                const pr = await client.pulls.create({
                    base: "master",
                    title: `Automated PR for pulumi-terraform-bridge commit ${checkoutSHA}`,
                    repo: github.context.issue.repo,
                    owner: github.context.issue.owner,
                    head: branchName,
                    draft: true,
                })

                await client.issues.createComment({
                    owner: github.context.issue.owner,
                    repo: github.context.issue.repo,
                    issue_number: github.context.issue.number,
                    body: `PR for ${downstreamName} with pulumi-terraform-bridge commit ${checkoutSHA} opened at ${pr.data.url}`,
                });
            } else {
                const url = `https://pulumi-bot:${pulumiBotToken}@github.com/pulumi-bot/${downstreamName}`;

                await exec("git", ["remote", "add", "pulumi-bot", url], inDownstreamOptions);
                await exec("git", ["push", "pulumi-bot", "--set-upstream", "--force", branchName], inDownstreamOptions);

                const newCommitSha = await find_commit_sha(downstreamDir, 0);
                const oldCommitSha = await find_commit_sha(downstreamDir, 1);

                const diffUrl = `https://github.com/pulumi-bot/${downstreamName}/compare/${oldCommitSha}..${newCommitSha}`;

                await client.issues.createComment({
                    owner: github.context.issue.owner,
                    repo: github.context.issue.repo,
                    issue_number: github.context.issue.number,
                    body: `Diff for [${downstreamName}](${diffUrl}) with merge commit ${checkoutSHA}`,
                });
            }
        } else {
            await exec("git", ["show"], inDownstreamOptions);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
