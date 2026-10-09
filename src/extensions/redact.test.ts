import { describe, expect, it } from "vitest";

import { hookSummary, mcpSummary, redactCommand } from "./redact.js";

// Built from pieces so the repo's push protection does not take the fixture for a real key.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

describe("redactCommand", () => {
  it("hides key-shaped words, the value after a secret-named flag, and URL credentials", () => {
    expect(redactCommand(["npx", "server", "--api-key", "plain-looking-value", `--token=${KEY}`, KEY])).toBe(
      "npx server --api-key <hidden> --token=<hidden> <hidden>",
    );
    expect(redactCommand(["curl", "https://user:pw@host.example/path?key=abc"])).toBe(
      "curl https://<hidden>@host.example/path?<hidden>",
    );
  });
});

describe("redactCommand on a token that is not key-shaped", () => {
  // Lowercase hex, which the key-shape check misses: what a self-hosted gateway often issues.
  const HEX = "0123456789abcdef".repeat(2);
  const command = (line: string) => hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";

  it("hides the value of a NAME=value whose name says it is a secret", () => {
    const docker = redactCommand(["docker", "run", "-e", `GITHUB_TOKEN=${HEX}`, "img"]);
    expect(docker).toBe("docker run -e GITHUB_TOKEN=<hidden> img");
    const prefixed = command(`TOKEN=${HEX} notify`);
    expect(prefixed).toBe("TOKEN=<hidden> notify");
    expect(`${docker} ${prefixed}`).not.toContain(HEX);
  });

  it("hides a secret header's value in one argument and across a quoted hook command", () => {
    const remote = redactCommand(["mcp-remote", "https://x.example/mcp", "--header", `Authorization: Bearer ${HEX}`]);
    expect(remote).toBe("mcp-remote https://x.example/mcp --header Authorization: <hidden>");
    // hookSummary splits at whitespace, so the quoted header arrives as three words.
    const curl = command(`curl -H "Authorization: Bearer ${HEX}" https://h.example`);
    expect(curl).toBe('curl -H "Authorization: <hidden>" https://h.example');
    expect(`${remote} ${curl}`).not.toContain(HEX);
  });

  it("hides the word after Bearer or Basic under any header name", () => {
    const arg = redactCommand(["server", "--header", `X-Upstream: Bearer ${HEX}`]);
    expect(arg).toBe("server --header X-Upstream: Bearer <hidden>");
    const hook = command(`notify --header "X-Upstream: Basic ${HEX}" done`);
    expect(hook).toBe('notify --header "X-Upstream: Basic <hidden>" done');
    expect(`${arg} ${hook}`).not.toContain(HEX);
  });

  it("hides the password of the user:password after -u or --user, and leaves a bare user", () => {
    const curl = redactCommand(["curl", "-u", `alice:${HEX}`, `--user=bob:${HEX}`, "https://h.example"]);
    expect(curl).toBe("curl -u alice:<hidden> --user=bob:<hidden> https://h.example");
    expect(curl).not.toContain(HEX);
    expect(redactCommand(["curl", "-u", "alice", "https://h.example"])).toBe("curl -u alice https://h.example");
  });

  it("hides the query of a URL anywhere in a word", () => {
    const shown = [
      [
        command(`curl -s "https://h.example/notify?token=${HEX}&m=done"`),
        'curl -s "https://h.example/notify?<hidden>"',
      ],
      [command(`curl 'https://h.example/n?apikey=${HEX}'`), "curl 'https://h.example/n?<hidden>'"],
      [redactCommand(["srv", `--url=https://h.example/mcp?token=${HEX}`]), "srv --url=https://h.example/mcp?<hidden>"],
      [command(`ENDPOINT=https://h.example/n?key=${HEX} run`), "ENDPOINT=https://h.example/n?<hidden> run"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("hides a value after any secret-named key: in a header, in JSON, in a form body", () => {
    const shown = [
      [
        command(`curl --header "X-Auth-Token: ${HEX}" https://h.example`),
        'curl --header "X-Auth-Token: <hidden>" https://h.example',
      ],
      [redactCommand(["curl", "-H", `PRIVATE-TOKEN:${HEX}`]), "curl -H PRIVATE-TOKEN:<hidden>"],
      [command(`curl -H "X-Api-Token: ${HEX}"`), 'curl -H "X-Api-Token: <hidden>"'],
      [redactCommand(["srv", "--config", `{"apiKey":"${HEX}"}`]), 'srv --config {"apiKey":"<hidden>"}'],
      [command(`curl -d '{"token":"${HEX}"}' https://h.example`), `curl -d '{"token":"<hidden>"}' https://h.example`],
      [
        command(`curl -d "user=bob&password=${HEX}" https://h.example`),
        'curl -d "user=bob&password=<hidden>" https://h.example',
      ],
      [command(`http POST h.example Authorization:"Bearer ${HEX}"`), 'http POST h.example Authorization:"<hidden>"'],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
    // No separator, no value: prose that names a secret is left as written.
    const prose = "Rotate the token when the key expires";
    expect(hookSummary("Stop", undefined, { type: "prompt", prompt: prose }).prompt).toBe(prose);
  });

  it("hides opaque path segments: webhook secrets, UUIDs, a bot token", () => {
    // Built from pieces so push protection does not take them for real webhooks.
    const slack = ["https://hooks.slack.com", "services", "T0ABCDEFG", "B0ABCDEFG"].join("/");
    const discord = ["https://discord.com", "api", "webhooks", "123456789012345678"].join("/");
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const shown = [
      [command(`curl -X POST ${slack}/${HEX}`), `curl -X POST ${slack}/<hidden>`],
      [redactCommand(["notify", `${discord}/${HEX}`]), `notify ${discord}/<hidden>`],
      [
        redactCommand(["curl", `https://api.telegram.org/bot123456789:${HEX}/sendMessage`]),
        "curl https://api.telegram.org/bot123456789:<hidden>/sendMessage",
      ],
      [
        mcpSummary({ type: "http", url: `https://mcp.pipedream.net/${uuid}/gmail` }).url ?? "",
        "https://mcp.pipedream.net/<hidden>/gmail",
      ],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
      expect(actual).not.toContain(uuid);
    }
  });

  it("covers the other secret words, attached -u and -H, the proxy user and the token scheme", () => {
    const shown = [
      [
        redactCommand([
          "srv",
          "--pat",
          HEX,
          `GITHUB_PAT=${HEX}`,
          `--jwt=${HEX}`,
          `SESSION_TOKEN=${HEX}`,
          "--pwd",
          HEX,
          "--bearer",
          HEX,
        ]),
        "srv --pat <hidden> GITHUB_PAT=<hidden> --jwt=<hidden> SESSION_TOKEN=<hidden> --pwd <hidden> --bearer <hidden>",
      ],
      [
        redactCommand(["curl", `-ualice:${HEX}`, "-U", `proxy:${HEX}`, `--proxy-user=p:${HEX}`]),
        "curl -ualice:<hidden> -U proxy:<hidden> --proxy-user=p:<hidden>",
      ],
      [redactCommand(["srv", "--header", `X-Upstream: token ${HEX}`]), "srv --header X-Upstream: token <hidden>"],
      [command(`curl -H"X-Api-Key: ${HEX}" https://h.example`), 'curl -H"X-Api-Key: <hidden>" https://h.example'],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("hides the token after a scheme that is not a word of its own, or inside a quoted value", () => {
    const shown = [
      [
        redactCommand(["srv", `{"headers":{"Authorization":"Bearer ${HEX}"}}`]),
        'srv {"headers":{"Authorization":"<hidden>"}}',
      ],
      [redactCommand(["srv", `{"token":"Bearer ${HEX}"}`]), 'srv {"token":"<hidden>"}'],
      [redactCommand(["srv", `X-Upstream:Bearer ${HEX}`]), "srv X-Upstream:Bearer <hidden>"],
      [redactCommand(["srv", `X-Upstream:"Bearer ${HEX}"`]), 'srv X-Upstream:"Bearer <hidden>"'],
      [redactCommand(["srv", `use=Bearer ${HEX}`]), "srv use=Bearer <hidden>"],
      [
        command(`curl -d '{"Authorization":"Bearer ${HEX}"}' https://h.example`),
        `curl -d '{"Authorization":"<hidden>"}' https://h.example`,
      ],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("reads a secret word with a number after it as the word", () => {
    const numbered = redactCommand([
      "srv",
      `TOKEN1=${HEX}`,
      `API_KEY2=${HEX}`,
      `apiKey2=${HEX}`,
      "--apikey2",
      HEX,
      `--oauth2=${HEX}`,
    ]);
    expect(numbered).toBe(
      "srv TOKEN1=<hidden> API_KEY2=<hidden> apiKey2=<hidden> --apikey2 <hidden> --oauth2=<hidden>",
    );
    expect(numbered).not.toContain(HEX);
  });

  it("hides all of an argument's value that starts with a secret assignment or a user:password", () => {
    const shown = [
      [
        redactCommand(["docker", "run", "-e", `AUTHORIZATION=Bearer ${HEX}`, "img"]),
        "docker run -e AUTHORIZATION=<hidden> img",
      ],
      [redactCommand(["srv", `--token=Bearer ${HEX}`]), "srv --token=<hidden>"],
      [redactCommand(["srv", `--api-key=two ${HEX}`]), "srv --api-key=<hidden>"],
      [redactCommand(["env", `API_KEY=a ${HEX}`, "srv"]), "env API_KEY=<hidden> srv"],
      [redactCommand(["curl", "-u", `alice:a ${HEX}`]), "curl -u alice:<hidden>"],
      [redactCommand(["curl", `--user=alice:a ${HEX}`]), "curl --user=alice:<hidden>"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
    // A shell's command line is words, not one value: the command after the assignment is shown.
    expect(redactCommand(["bash", "-c", `API_KEY=${HEX} run`])).toBe("bash -c API_KEY=<hidden> run");
    expect(mcpSummary({ command: `API_KEY=${HEX} node srv` }).command).toBe("API_KEY=<hidden> node srv");
  });

  it("matches secret words against whole name parts, so a name that only contains one is shown", () => {
    const plain = [
      redactCommand(["srv", "--path", "/x"]),
      command("PATH=/usr/bin:/bin cmd"),
      redactCommand(["rg", "--pattern", "foo"]),
      redactCommand(["srv", "--session-name", "work", "--dispatch-mode=fast"]),
      redactCommand(["docker", "run", "keycloak:24.0"]),
    ];
    expect(plain).toEqual([
      "srv --path /x",
      "PATH=/usr/bin:/bin cmd",
      "rg --pattern foo",
      "srv --session-name work --dispatch-mode=fast",
      "docker run keycloak:24.0",
    ]);
    // A part that ends in a secret word is one: `apikey`, `authtoken` written as one word.
    const compound = redactCommand([
      "srv",
      "--apikey",
      HEX,
      `NGROK_AUTHTOKEN=${HEX}`,
      `APIKey=${HEX}`,
      "--secrets",
      HEX,
    ]);
    expect(compound).toBe("srv --apikey <hidden> NGROK_AUTHTOKEN=<hidden> APIKey=<hidden> --secrets <hidden>");
    expect(compound).not.toContain(HEX);
  });
});

describe("redactCommand after a shell's command option", () => {
  const HEX = "0123456789abcdef".repeat(2);

  it("reads another program's -c, -C or /c argument as one value, so all of it stays hidden", () => {
    const shown = [
      [redactCommand(["srv", "-c", `AUTH_HEADER=Bearer ${HEX}`]), "srv -c AUTH_HEADER=<hidden>"],
      [redactCommand(["make", "-C", `TOKEN=a ${HEX}`]), "make -C TOKEN=<hidden>"],
      [redactCommand(["srv", "-c", `--api-key a ${HEX}`]), "srv -c --api-key <hidden>"],
      [redactCommand(["tool", "/c", `TOKEN=a ${HEX}`]), "tool /c TOKEN=<hidden>"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("still reads a shell's command line word by word, its secret hidden and its command shown", () => {
    const shown = [
      [redactCommand(["bash", "-c", `API_KEY=${HEX} npx srv`]), "bash -c API_KEY=<hidden> npx srv"],
      [redactCommand(["sh", "-euc", `API_KEY=${HEX} npx srv`]), "sh -euc API_KEY=<hidden> npx srv"],
      [redactCommand(["/bin/zsh", "-lc", `npx srv --token ${HEX}`]), "/bin/zsh -lc npx srv --token <hidden>"],
      [redactCommand(["env", "bash", "-c", `API_KEY=${HEX} npx srv`]), "env bash -c API_KEY=<hidden> npx srv"],
      [
        redactCommand(["docker", "exec", "ctr", "sh", "-c", `API_KEY=${HEX} run`]),
        "docker exec ctr sh -c API_KEY=<hidden> run",
      ],
      [
        redactCommand(["bash", "-e", "-o", "pipefail", "-c", `TOKEN=${HEX} run`]),
        "bash -e -o pipefail -c TOKEN=<hidden> run",
      ],
      [redactCommand(["cmd", "/c", `set TOKEN=${HEX} && srv`]), "cmd /c set TOKEN=<hidden> && srv"],
      [
        redactCommand(["C:\\Windows\\System32\\CMD.EXE", "/K", `srv --token ${HEX}`]),
        "C:\\Windows\\System32\\CMD.EXE /K srv --token <hidden>",
      ],
      [redactCommand(["pwsh", "-Command", `srv --api-key ${HEX} -v`]), "pwsh -Command srv --api-key <hidden> -v"],
      [
        redactCommand(["powershell.exe", "-c", `srv --api-key ${HEX} -v`]),
        "powershell.exe -c srv --api-key <hidden> -v",
      ],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("matches a POSIX shell's -c with its case, as the shell does", () => {
    // bash -C is noclobber, not a command line: its argument stays one value.
    expect(redactCommand(["bash", "-C", `TOKEN=a ${HEX}`])).toBe("bash -C TOKEN=<hidden>");
  });

  it("hides a passphrase, and a cookie after -b or --cookie", () => {
    const shown = [
      [
        redactCommand(["srv", "--passphrase", HEX, `KEY_PASSPHRASE=${HEX}`]),
        "srv --passphrase <hidden> KEY_PASSPHRASE=<hidden>",
      ],
      [
        redactCommand([
          "curl",
          "-b",
          `session=${HEX}`,
          "--cookie",
          `sid=${HEX}`,
          `--cookie=sid=${HEX}`,
          "https://h.example",
        ]),
        "curl -b <hidden> --cookie <hidden> --cookie=<hidden> https://h.example",
      ],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });
});

describe("mcpSummary", () => {
  it("shows transport, command and the names - never the values - of env and headers", () => {
    const summary = mcpSummary({
      command: "npx",
      args: ["-y", "@acme/mcp"],
      env: { GITHUB_TOKEN: KEY, REGION: "eu" },
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(summary).toEqual({
      transport: "stdio",
      command: "npx -y @acme/mcp",
      env: "GITHUB_TOKEN, REGION",
      headers: "Authorization",
    });
    expect(JSON.stringify(summary)).not.toContain(KEY.slice(10, 30));
  });

  it("reads an http server and hides a token in its URL", () => {
    expect(mcpSummary({ type: "http", url: "https://mcp.example/mcp?token=abc" })).toEqual({
      transport: "http",
      url: "https://mcp.example/mcp?<hidden>",
    });
  });

  it("reads every word of an argument and of the command", () => {
    const HEX = "0123456789abcdef".repeat(2);
    const nested = mcpSummary({ command: "bash", args: ["-c", `npx -y srv --api-key ${HEX}`] }).command;
    expect(nested).toBe("bash -c npx -y srv --api-key <hidden>");
    const whole = mcpSummary({ command: `npx srv --token ${HEX}` }).command;
    expect(whole).toBe("npx srv --token <hidden>");
    expect(`${nested} ${whole}`).not.toContain(HEX);
  });
});

describe("hookSummary", () => {
  it("keeps event, matcher, type and a redacted command", () => {
    expect(hookSummary("PreToolUse", "Bash", { type: "command", command: `check --key ${KEY}` })).toEqual({
      event: "PreToolUse",
      matcher: "Bash",
      type: "command",
      command: "check --key <hidden>",
    });
  });
});
