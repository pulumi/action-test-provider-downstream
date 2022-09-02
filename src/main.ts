import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as io from "@actions/io";
import * as path from "path";
import * as fs from "fs";

async function find_gopath(): Promise<string> {
    let output = "";
    const options = {
        listeners: {
            stdline: (data) => (output += data),
        },
    };

    await exec("go", ["env", "GOPATH"], options);

    return output.trim();
}

async function find_commit_sha(path: string, offset: number = 0): Promise<string> {
    let output = "";
    const options = {
        cwd: path,
        listeners: {
            stdline: (data) => (output += data),
        },
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

        const replacementsStr =
            core.getInput("replacements") || "github.com/pulumi/pulumi-terraform-bridge/v2=pulumi-terraform-bridge";
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
        let hasPullRequestToken = false;
        const pullRequestToken = core.getInput("GITHUB_TOKEN") ?? core.getInput("pulumi-bot-token");
        if (pullRequestToken != undefined && pullRequestToken != "") {
            core.setSecret(pullRequestToken);
            hasPullRequestToken = true;
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

        await exec("go", ["mod", "tidy", "-compat=1.17"], inDownstreamModOptions);
        await exec("git", ["commit", "-a", "-m", `Replace ${upstream} module`], inDownstreamOptions);

        const summaryDir = "summary"
        await io.mkdirP(summaryDir);
        await exec("make", ["only_build"], {
            ...inDownstreamOptions,
            env: {
                ...inDownstreamOptions.env,
                COVERAGE_OUTPUT_DIR: summaryDir,
            }});

        try {
            const f = fs.readFileSync(`${summaryDir}/summary.json`);
            const json = JSON.parse(f.toString());
            const fatals = json.Fatals.Number;
            if (fatals > 0) {
                core.setFailed(`Found ${fatals} fatal errors during codegen`);
            }
            core.summary.addRaw(fs.readFileSync(`${summaryDir}/summary.json`).toString());
        } catch (err) {
            // Not all providers have a summary, so if no file gets generated, we do nothing
            if (err instanceof Error) {
                const e: any = err;
                if (e.code !== 'ENOENT') throw err;
            }
        }

        await exec("git", ["add", "."], inDownstreamOptions);
        await exec(
            "git",
            ["commit", "--allow-empty", "-m", `Update to ${upstream}@${checkoutSHA}`],
            inDownstreamOptions
        );

        if (hasPullRequestToken) {
            const url = `https://pulumi-bot:${pullRequestToken}@github.com/pulumi-bot/${downstreamName}`;

            await exec("git", ["remote", "add", "pulumi-bot", url], inDownstreamOptions);
            await exec("git", ["push", "pulumi-bot", "--set-upstream", "--force", branchName], inDownstreamOptions);

            const newCommitSha = await find_commit_sha(downstreamDir, 0);
            const oldCommitSha = await find_commit_sha(downstreamDir, 1);

            const diffUrl = `https://github.com/pulumi-bot/${downstreamName}/compare/${oldCommitSha}..${newCommitSha}`;

            // Write to summary markdown file for workflow.
            core.summary.addRaw(`Diff for [${downstreamName}](${diffUrl}) with merge commit ${checkoutSHA}\n`).write();
        } else {
            await exec("git", ["show"], inDownstreamOptions);
        }
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        } else {
            core.setFailed(`Unhandled exception: ${error}`);
        }
    }
}

run();
