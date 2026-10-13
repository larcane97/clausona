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

describe("redactCommand after a flag that takes no value, or a bare auth scheme", () => {
  const HEX = "0123456789abcdef".repeat(2);
  const command = (line: string) => hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";
  const mcp = (args: string[]) => mcpSummary({ command: "tool", args }).command ?? "";

  it("reads an option after -b, --cookie or a secret-named flag by its own rule, so its secret stays hidden", () => {
    const shown = [
      [mcp(["-b", "--api-key", HEX]), "tool -b --api-key <hidden>"],
      [mcp(["--cookie", "--password", HEX]), "tool --cookie --password <hidden>"],
      [redactCommand(["srv", "--auth", "--api-key", HEX]), "srv --auth --api-key <hidden>"],
      [command(`tool -b --api-key ${HEX}`), "tool -b --api-key <hidden>"],
      [command(`tool --cookie --password ${HEX}`), "tool --cookie --password <hidden>"],
      [command(`srv --auth --api-key ${HEX}`), "srv --auth --api-key <hidden>"],
      // A cookie that is a value is hidden as before.
      [command(`curl -b sid=${HEX} https://h.example`), "curl -b <hidden> https://h.example"],
      [command(`curl --cookie sid=${HEX} https://h.example`), "curl --cookie <hidden> https://h.example"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });

  it("hides a flag's value that starts with a dash, unless that word's own rule hides what it carries", () => {
    // URL-safe base64 tokens and generated passwords can start with a dash. Built from pieces.
    const DASHED = ["-AbC9xyz", "x"].join("_");
    const LOOKS_NAMED = ["-xKey9", "AbC"].join("");
    const shown = [
      [mcp(["--token", DASHED]), "tool --token <hidden>"],
      [command(`tool --token ${DASHED}`), "tool --token <hidden>"],
      [mcp(["--password", "-Xk9_q2", "--v"]), "tool --password <hidden> --v"],
      [command("tool --password -Xk9_q2 --v"), "tool --password <hidden> --v"],
      // A dash-led token that a single-dash option name would match is still a value.
      [mcp(["--token", LOOKS_NAMED]), "tool --token <hidden>"],
      [mcp(["-b", "Bearer", HEX]), "tool -b Bearer <hidden>"],
      [mcp(["--token", "Bearer", HEX]), "tool --token Bearer <hidden>"],
      [command(`tool -b X-Api-Key: ${HEX}`), "tool -b X-Api-Key: <hidden>"],
      [mcp(["--token", `--api-key=${HEX}`]), "tool --token --api-key=<hidden>"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      for (const secret of [HEX, DASHED, "-Xk9_q2", LOOKS_NAMED]) expect(actual).not.toContain(secret);
    }
  });

  it("hides all of a quoted cookie assignment, to its closing quote", () => {
    const shown = command(`curl --cookie="a=1 sid=${HEX}" https://h.example`);
    expect(shown).toBe('curl --cookie="<hidden>" https://h.example');
    expect(shown).not.toContain(HEX);
  });

  it("hides the argument after one that ends in a bare Bearer or Basic", () => {
    const shown = [
      [mcp(["--header", "Authorization: Bearer", HEX]), "tool --header Authorization: <hidden>"],
      [mcp(["--header", "Authorization: Basic", HEX, "--verbose"]), "tool --header Authorization: <hidden> --verbose"],
      [mcp(["-c", "Authorization: Bearer", HEX]), "tool -c Authorization: <hidden>"],
    ];
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      expect(actual).not.toContain(HEX);
    }
  });
});

describe("redactCommand on the shapes a differential against the first version found open", () => {
  const HEX = "0123456789abcdef".repeat(2);
  const command = (line: string) => hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";
  const mcp = (args: string[]) => mcpSummary({ command: "tool", args }).command ?? "";
  const hidden = (shown: [string, string][], secrets: string[] = [HEX]) => {
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      for (const secret of secrets) expect(actual).not.toContain(secret);
    }
  };

  it("hides SQL's password literal, after PASSWORD or IDENTIFIED BY", () => {
    hidden([
      [redactCommand(["psql", "-c", `ALTER ROLE r PASSWORD '${HEX}'`]), "psql -c ALTER ROLE r PASSWORD '<hidden>'"],
      [command(`psql -c "ALTER ROLE r PASSWORD '${HEX}'"`), `psql -c "ALTER ROLE r PASSWORD '<hidden>'"`],
      [
        command(`psql -c "CREATE USER u WITH ENCRYPTED PASSWORD 'a ${HEX}'"`),
        `psql -c "CREATE USER u WITH ENCRYPTED PASSWORD '<hidden>'"`,
      ],
      [
        redactCommand(["mysql", "-e", `CREATE USER u IDENTIFIED BY '${HEX}'`]),
        "mysql -e CREATE USER u IDENTIFIED BY '<hidden>'",
      ],
      // What follows the literal is shown.
      [
        command(`psql -c "alter user u password '${HEX}' valid until 'infinity'"`),
        `psql -c "alter user u password '<hidden>' valid until 'infinity'"`,
      ],
    ]);
  });

  it("hides a secret key's spaced value in a form body, to the end of its argument or quoted string", () => {
    hidden([
      [mcp(["-d", `user=bob&password=a ${HEX}`]), "tool -d user=bob&password=<hidden>"],
      [
        command(`curl -d "user=bob&password=a ${HEX}" https://h.example`),
        `curl -d "user=bob&password=<hidden>" https://h.example`,
      ],
      [
        command(`curl -d "a=1 password=a ${HEX}" https://h.example`),
        `curl -d "a=1 password=<hidden>" https://h.example`,
      ],
      // In a shell's command line: one argument there, for the program the shell runs.
      [
        redactCommand(["bash", "-c", `curl -d 'user=bob&password=a ${HEX}' https://h.example`]),
        "bash -c curl -d 'user=bob&password=<hidden>' https://h.example",
      ],
      [
        command(`bash -c "curl --data 'x=1&token=a ${HEX}&y=2' https://h.example"`),
        `bash -c "curl --data 'x=1&token=<hidden>' https://h.example"`,
      ],
    ]);
  });

  it("hides a Go-style secret flag's value after -b, --cookie or --auth, the flag too", () => {
    hidden([
      [mcp(["-b", "-token", HEX]), "tool -b <hidden> <hidden>"],
      [command(`tool -b -token ${HEX}`), "tool -b <hidden> <hidden>"],
      [mcp(["--auth", "-api-key", HEX, "--verbose"]), "tool --auth <hidden> <hidden> --verbose"],
      [command(`tool --cookie -password "a ${HEX}"`), `tool --cookie <hidden> "<hidden>"`],
    ]);
  });

  it("hides a value that starts with -- and reads like a secret flag, and the word after it", () => {
    // Built from pieces: what a generated password or token can look like.
    const NAMED = ["--Tk9q2", "Secret"].join("");
    const RANDOM = ["--x9f3k2", "token"].join("-");
    hidden(
      [
        [mcp(["--password", NAMED]), "tool --password <hidden>"],
        [mcp(["--token", RANDOM, HEX]), "tool --token <hidden> <hidden>"],
        [command(`tool --api-key ${NAMED} ${HEX}`), "tool --api-key <hidden> <hidden>"],
        // An option spelled as option names are is still read as one.
        [mcp(["--auth", "--api-key", HEX]), "tool --auth --api-key <hidden>"],
      ],
      [HEX, NAMED, RANDOM],
    );
  });

  it("hides all of a secret flag's quoted value, or one argument of several words, whatever it starts with", () => {
    hidden([
      [command(`tool --token "-u ${HEX}"`), `tool --token "<hidden>"`],
      [command(`tool --password '-b ${HEX}'`), "tool --password '<hidden>'"],
      [command(`tool --secret "-H ${HEX}"`), `tool --secret "<hidden>"`],
      [command(`tool --token "Bearer ${HEX}"`), `tool --token "<hidden>"`],
      [mcp(["--token", `-u ${HEX}`]), "tool --token <hidden>"],
      [mcp(["-api-key", `-H ${HEX}`]), "tool -api-key <hidden>"],
    ]);
  });

  it("hides a cookie or a password whose quote opens after = or :, to its closing quote", () => {
    hidden([
      [command(`curl -b TOKEN='a ${HEX}' https://h.example`), "curl -b <hidden> https://h.example"],
      [command(`curl --cookie sid="a ${HEX}" https://h.example`), "curl --cookie <hidden> https://h.example"],
      [command(`curl --cookie=sid='a ${HEX}' https://h.example`), "curl --cookie=<hidden> https://h.example"],
      [command(`curl -u alice:'a ${HEX}' https://h.example`), "curl -u alice:<hidden> https://h.example"],
    ]);
  });

  it("hides the word after a quoted header value that ends in a bare scheme", () => {
    hidden([
      [command(`curl --header "Authorization: Bearer" ${HEX}`), `curl --header "Authorization: <hidden>" <hidden>`],
      [command(`curl -H "X-Upstream: Basic" ${HEX} -s`), `curl -H "X-Upstream: Basic" <hidden> -s`],
      [command(`curl --header 'X-Upstream:Bearer' ${HEX}`), "curl --header 'X-Upstream:Bearer' <hidden>"],
    ]);
  });

  it("shows the branch after git's -b, and still reads -b as curl's cookie everywhere else", () => {
    expect(redactCommand(["git", "checkout", "-b", "feature"])).toBe("git checkout -b feature");
    expect(command("git -C /srv/repo checkout -b fix/login origin/main")).toBe(
      "git -C /srv/repo checkout -b fix/login origin/main",
    );
    expect(redactCommand(["bash", "-c", "cd /srv && git checkout -b feature"])).toBe(
      "bash -c cd /srv && git checkout -b feature",
    );
    hidden([
      [
        command(`git checkout -b feature && curl -b sid=${HEX} https://h.example`),
        "git checkout -b feature && curl -b <hidden> https://h.example",
      ],
      [command(`git pull | tool -b ${HEX}`), "git pull | tool -b <hidden>"],
      [mcp(["--name", "git", "-b", HEX]), "tool --name git -b <hidden>"],
      [mcp(["-b", HEX]), "tool -b <hidden>"],
    ]);
  });
});

describe("redactCommand on the shapes the differential left after #97", () => {
  const HEX = "0123456789abcdef".repeat(2);
  const command = (line: string) => hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";
  const mcp = (args: string[]) => mcpSummary({ command: "tool", args }).command ?? "";
  const hidden = (shown: [string, string][], secrets: string[] = [HEX]) => {
    for (const [actual, expected] of shown) {
      expect(actual).toBe(expected);
      for (const secret of secrets) expect(actual).not.toContain(secret);
    }
  };

  it("reads a secret-named option after a secret flag as the flag's value, unless it takes a plain value", () => {
    // A password spelled like an option named for a secret. Built from pieces.
    const SPELLED = ["--my", "token"].join("");
    hidden(
      [
        [mcp(["--password", SPELLED]), "tool --password <hidden>"],
        [command(`tool --token ${SPELLED}`), "tool --token <hidden>"],
        // What it would take starts with a dash or ends the command: hidden as before, and it too.
        [command(`tool --api-key ${SPELLED} --verbose`), "tool --api-key <hidden> <hidden>"],
        [command(`tool --secret ${SPELLED} && notify`), "tool --secret <hidden> <hidden> notify"],
        [mcp(["--password", SPELLED, "-H", `X-Api-Key: ${HEX}`]), "tool --password <hidden> -H X-Api-Key: <hidden>"],
        [mcp(["--auth", "--api-key", SPELLED]), "tool --auth <hidden> <hidden>"],
      ],
      [HEX, SPELLED],
    );
    // An option with a plain value is still an option, as before.
    hidden([
      [mcp(["--auth", "--api-key", HEX]), "tool --auth --api-key <hidden>"],
      [command(`tool -b --api-key ${HEX} --verbose`), "tool -b --api-key <hidden> --verbose"],
    ]);
  });

  it("shows -b and what follows under a tool whose -b is no cookie, and reads it as curl's elsewhere", () => {
    expect(redactCommand(["tar", "-c", "-b", "20", "-f", "out.tar", "dir"])).toBe("tar -c -b 20 -f out.tar dir");
    expect(command("sort -b -k 2 names.txt")).toBe("sort -b -k 2 names.txt");
    expect(command("du -b /srv/data | sort -b")).toBe("du -b /srv/data | sort -b");
    expect(command("sudo rsync -b -a src/ dst/")).toBe("sudo rsync -b -a src/ dst/");
    expect(redactCommand(["bash", "-c", "cut -b 1-8 app.log && split -b 1m app.log part"])).toBe(
      "bash -c cut -b 1-8 app.log && split -b 1m app.log part",
    );
    // Its command's first word decides, so a tool's name as an argument does not.
    expect(command("tar -f sort -b 20 -x")).toBe("tar -f sort -b 20 -x");
    hidden([
      [
        command(`tar -b 20 -xf a.tar && curl -b sid=${HEX} https://h.example`),
        "tar -b 20 -xf a.tar && curl -b <hidden> https://h.example",
      ],
      [mcp(["--name", "tar", "-b", HEX]), "tool --name tar -b <hidden>"],
      [command(`docker run img sort -b ${HEX}`), "docker run img sort -b <hidden>"],
      // A program's -c in a shell's command line is that program's: what follows starts nothing.
      [redactCommand(["bash", "-c", `tool -c tar -b ${HEX}`]), "bash -c tool -c tar -b <hidden>"],
      [command(`bash -c "tool -c git -b ${HEX}"`), `bash -c "tool -c git -b <hidden>"`],
      // So does a word that runs the next one, when it is an argument itself.
      [mcp(["--mode", "time", "sort", "-b", HEX]), "tool --mode time sort -b <hidden>"],
      [command(`tool --run env git -b ${HEX}`), "tool --run env git -b <hidden>"],
      // A tool whose -b can be a secret is not one of them: gh secret set takes the secret there.
      [command(`gh secret set API_TOKEN -b ${HEX}`), "gh secret set API_TOKEN -b <hidden>"],
      // Nor one whose later words are another program's: a script's, a remote command's.
      [command(`python3 fetch.py -b ${HEX}`), "python3 fetch.py -b <hidden>"],
      [command(`ssh host fetch -b ${HEX}`), "ssh host fetch -b <hidden>"],
    ]);
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
