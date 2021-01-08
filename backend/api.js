import { spawn } from "child_process";
import path from "path";
import WebSocket from "ws";

import pty from "node-pty";
import pQueue from "p-queue";
const PQueue = pQueue.default;
import rpc from "vscode-jsonrpc";
import { v4 as getUUID } from "uuid";

import { langs } from "./langs.js";
import { borrowUser } from "./users.js";
import * as util from "./util.js";
import { bash } from "./util.js";

const allSessions = new Set();

export class Session {
  get homedir() {
    return `/tmp/riju/${this.uuid}`;
  }

  get config() {
    return langs[this.lang];
  }

  get uid() {
    return this.uidInfo.uid;
  }

  returnUser = async () => {
    this.uidInfo && (await this.uidInfo.returnUser());
  };

  get context() {
    return { uid: this.uid, uuid: this.uuid };
  }

  log = (msg) => this.logPrimitive(`[${this.uuid}] ${msg}`);

  constructor(ws, lang, log) {
    this.ws = ws;
    this.uuid = getUUID();
    this.lang = lang;
    this.tearingDown = false;
    this.uidInfo = null;
    this.term = null;
    this.lsp = null;
    this.daemon = null;
    this.formatter = null;
    this.logPrimitive = log;
    this.msgQueue = new PQueue({ concurrency: 1 });
    this.log(`Creating session, language ${this.lang}`);
  }

  run = async (args, options) => {
    return await util.run(args, this.log, options);
  };

  privilegedSetup = () => util.privilegedSetup(this.context);
  privilegedSpawn = (args) => util.privilegedSpawn(this.context, args);
  privilegedUseradd = () => util.privilegedUseradd(this.uid);
  privilegedTeardown = () => util.privilegedTeardown(this.context);

  setup = async () => {
    try {
      allSessions.add(this);
      const { uid, returnUser } = await borrowUser();
      this.uidInfo = { uid, returnUser };
      this.log(`Borrowed uid ${this.uid}`);
      await this.run(this.privilegedSetup());
      if (this.config.setup) {
        await this.run(this.privilegedSpawn(bash(this.config.setup)));
      }
      await this.runCode();
      if (this.config.daemon) {
        const daemonArgs = this.privilegedSpawn(bash(this.config.daemon));
        const daemonProc = spawn(daemonArgs[0], daemonArgs.slice(1));
        this.daemon = {
          proc: daemonProc,
        };
        for (const stream of [daemonProc.stdout, daemonProc.stderr]) {
          stream.on("data", (data) =>
            this.send({
              event: "serviceLog",
              service: "daemon",
              output: data.toString("utf8"),
            })
          );
          daemonProc.on("close", (code, signal) =>
            this.send({
              event: "serviceFailed",
              service: "daemon",
              error: `Exited with status ${signal || code}`,
            })
          );
          daemonProc.on("error", (err) =>
            this.send({
              event: "serviceFailed",
              service: "daemon",
              error: `${err}`,
            })
          );
        }
      }
      if (this.config.lsp) {
        if (this.config.lsp.setup) {
          await this.run(this.privilegedSpawn(bash(this.config.lsp.setup)));
        }
        const lspArgs = this.privilegedSpawn(bash(this.config.lsp.start));
        const lspProc = spawn(lspArgs[0], lspArgs.slice(1));
        this.lsp = {
          proc: lspProc,
          reader: new rpc.StreamMessageReader(lspProc.stdout),
          writer: new rpc.StreamMessageWriter(lspProc.stdin),
        };
        this.lsp.reader.listen((data) => {
          this.send({ event: "lspOutput", output: data });
        });
        lspProc.stderr.on("data", (data) =>
          this.send({
            event: "serviceLog",
            service: "lsp",
            output: data.toString("utf8"),
          })
        );
        lspProc.on("close", (code, signal) =>
          this.send({
            event: "serviceFailed",
            service: "lsp",
            error: `Exited with status ${signal || code}`,
          })
        );
        lspProc.on("error", (err) =>
          this.send({ event: "serviceFailed", service: "lsp", error: `${err}` })
        );
        this.send({ event: "lspStarted", root: this.homedir });
      }
      this.ws.on("message", (msg) =>
        this.msgQueue.add(() => this.receive(msg))
      );
      this.ws.on("close", async () => {
        await this.teardown();
      });
      this.ws.on("error", async (err) => {
        this.log(`Websocket error: ${err}`);
        await this.teardown();
      });
    } catch (err) {
      this.log(`Error while setting up environment`);
      console.log(err);
      this.sendError(err);
      await this.teardown();
    }
  };

  send = async (msg) => {
    try {
      if (this.tearingDown) {
        return;
      }
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`Failed to send websocket message: ${err}`);
      console.log(err);
      await this.teardown();
    }
  };

  sendError = async (err) => {
    await this.send({ event: "terminalClear" });
    await this.send({
      event: "terminalOutput",
      output: `Riju encountered an unexpected error: ${err}
\r
\rYou may want to save your code and refresh the page.
`,
    });
  };

  logBadMessage = (msg) => {
    this.log(`Got malformed message from client: ${JSON.stringify(msg)}`);
  };

  receive = async (event) => {
    try {
      if (this.tearingDown) {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event);
      } catch (err) {
        this.log(`Failed to parse message from client: ${event}`);
        return;
      }
      switch (msg && msg.event) {
        case "terminalInput":
          if (typeof msg.input !== "string") {
            this.logBadMessage(msg);
            break;
          }
          if (!this.term) {
            this.log("terminalInput ignored because term is null");
            break;
          }
          this.term.pty.write(msg.input);
          break;
        case "runCode":
          if (typeof msg.code !== "string") {
            this.logBadMessage(msg);
            break;
          }
          await this.runCode(msg.code);
          break;
        case "formatCode":
          if (typeof msg.code !== "string") {
            this.logBadMessage(msg);
            break;
          }
          await this.formatCode(msg.code);
          break;
        case "lspInput":
          if (typeof msg.input !== "object" || !msg) {
            this.logBadMessage(msg);
            break;
          }
          if (!this.lsp) {
            this.log(`lspInput ignored because lsp is null`);
            break;
          }
          this.lsp.writer.write(msg.input);
          break;
        case "ensure":
          if (!this.config.ensure) {
            this.log(`ensure ignored because of missing configuration`);
            break;
          }
          await this.ensure(this.config.ensure);
          break;
        default:
          this.logBadMessage(msg);
          break;
      }
    } catch (err) {
      this.log(`Error while handling message from client`);
      console.log(err);
      this.sendError(err);
    }
  };

  writeCode = async (code) => {
    if (this.config.main.includes("/")) {
      await this.run(
        this.privilegedSpawn([
          "mkdir",
          "-p",
          path.dirname(`${this.homedir}/${this.config.main}`),
        ])
      );
    }
    await this.run(
      this.privilegedSpawn([
        "sh",
        "-c",
        `cat > ${path.resolve(this.homedir, this.config.main)}`,
      ]),
      { input: code }
    );
  };

  runCode = async (code) => {
    try {
      const {
        name,
        repl,
        main,
        suffix,
        createEmpty,
        compile,
        run,
        template,
      } = this.config;
      if (this.term) {
        const pid = this.term.pty.pid;
        const args = this.privilegedSpawn(
          bash(`kill -SIGTERM ${pid}; sleep 1; kill -SIGKILL ${pid}`)
        );
        spawn(args[0], args.slice(1));
        // Signal to terminalOutput message generator using closure.
        this.term.live = false;
        this.term = null;
      }
      this.send({ event: "terminalClear" });
      let cmdline;
      if (code) {
        cmdline = run;
        if (compile) {
          cmdline = `( ${compile} ) && ( ${run} )`;
        }
      } else if (repl) {
        cmdline = repl;
      } else {
        cmdline = `echo '${name} has no REPL, press Run to see it in action'`;
      }
      if (code === undefined) {
        code = createEmpty !== undefined ? createEmpty : template + "\n";
      }
      if (code && suffix) {
        code += suffix + "\n";
      }
      await this.writeCode(code);
      const termArgs = this.privilegedSpawn(bash(cmdline));
      const term = {
        pty: pty.spawn(termArgs[0], termArgs.slice(1), {
          name: "xterm-color",
        }),
        live: true,
      };
      this.term = term;
      this.term.pty.on("data", (data) => {
        // Capture term in closure so that we don't keep sending output
        // from the old pty even after it's been killed (see ghci).
        if (term.live) {
          this.send({ event: "terminalOutput", output: data });
        }
      });
      this.term.pty.on("exit", (code, signal) => {
        if (term.live) {
          this.send({
            event: "serviceFailed",
            service: "terminal",
            error: `Exited with status ${signal || code}`,
          });
        }
      });
    } catch (err) {
      this.log(`Error while running user code`);
      console.log(err);
      this.sendError(err);
    }
  };

  formatCode = async (code) => {
    try {
      if (!this.config.format) {
        this.log("formatCode ignored because format is null");
        return;
      }
      if (this.formatter) {
        const pid = this.formatter.proc.pid;
        const args = this.privilegedSpawn(
          bash(`kill -SIGTERM ${pid}; sleep 1; kill -SIGKILL ${pid}`)
        );
        spawn(args[0], args.slice(1));
        this.formatter.live = false;
        this.formatter = null;
      }
      const args = this.privilegedSpawn(bash(this.config.format.run));
      const formatter = {
        proc: spawn(args[0], args.slice(1)),
        live: true,
        input: code,
        output: "",
      };
      formatter.proc.stdin.end(code);
      formatter.proc.stdout.on("data", (data) => {
        if (!formatter.live) return;
        formatter.output += data.toString("utf8");
      });
      formatter.proc.stderr.on("data", (data) => {
        if (!formatter.live) return;
        this.send({
          event: "serviceLog",
          service: "formatter",
          output: data.toString("utf8"),
        });
      });
      formatter.proc.on("close", (code, signal) => {
        if (!formatter.live) return;
        if (code === 0) {
          this.send({
            event: "formattedCode",
            code: formatter.output,
            originalCode: formatter.input,
          });
        } else {
          this.send({
            event: "serviceFailed",
            service: "formatter",
            error: `Exited with status ${signal || code}`,
          });
        }
      });
      formatter.proc.on("error", (err) => {
        if (!formatter.live) return;
        this.send({
          event: "serviceFailed",
          service: "formatter",
          error: `${err}`,
        });
      });
      this.formatter = formatter;
    } catch (err) {
      this.log(`Error while running code formatter`);
      console.log(err);
      this.sendError(err);
    }
  };

  ensure = async (cmd) => {
    const code = await this.run(this.privilegedSpawn(bash(cmd)), {
      check: false,
    });
    this.send({ event: "ensured", code });
  };

  teardown = async () => {
    try {
      if (this.tearingDown) {
        return;
      }
      this.log(`Tearing down session`);
      this.tearingDown = true;
      allSessions.delete(this);
      if (this.uidInfo) {
        await this.run(this.privilegedTeardown());
        await this.returnUser();
      }
      this.ws.terminate();
    } catch (err) {
      this.log(`Error during teardown`);
      console.log(err);
    }
  };
}
