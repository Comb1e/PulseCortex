import { mkdir } from "node:fs/promises";
import { loadConfig } from "@pulsecortex/config";
import { CodexAppServerDriver } from "@pulsecortex/codex-driver";
import { createLogger, retainDailyLogs, SessionCoordinator } from "@pulsecortex/core";
import { FeishuAdapter } from "@pulsecortex/feishu-adapter";
import { CommandLogStore, ControllerStore } from "@pulsecortex/persistence";
import { redact } from "@pulsecortex/domain";

async function main(): Promise<void> {
  const config = await loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.logDir, { recursive: true, mode: 0o700 });
  await mkdir(config.commandLogDir, { recursive: true, mode: 0o700 });
  await retainDailyLogs(config.logDir, config.logRetentionDays, config.logMaxBytes);
  const logger = createLogger(config.logLevel, { logDir: config.logDir, liveStatus: process.stdout.isTTY === true });
  const patterns = config.redactionPatterns.map((pattern) => new RegExp(pattern, "giu"));
  const store = new ControllerStore(config.databasePath, config.settingsPath);
  const interrupted = store.markActiveTurnsInterrupted();
  if (interrupted) store.audit({ eventType: "daemon.recovery", summary: `${interrupted} active turn(s) marked interrupted/unknown after restart` });
  const commandLogs = new CommandLogStore(config.commandLogDir, patterns);
  await commandLogs.retain(config.logRetentionDays, config.logMaxBytes);
  store.applyRetention(config.auditRetentionDays);

  const driver = new CodexAppServerDriver({
    commandLogs,
    listenUrl: config.codexAppServerUrl,
    onDiagnostic: ({ level, message, sessionId, details }) => {
      const diagnostic = {
        ...(sessionId ? { sessionId } : {}),
        ...(details ? { details: redact(JSON.stringify(details), patterns) } : {}),
      };
      const safeMessage = redact(message, patterns);
      if (level === "error") logger.error(diagnostic, safeMessage);
      else if (level === "warn") logger.warn(diagnostic, safeMessage);
      else if (level === "info") logger.info(diagnostic, safeMessage);
      else logger.debug(diagnostic, safeMessage);
    },
  });
  const capabilities = await driver.start();
  logger.info({ cliVersion: capabilities.cliVersion, protocolMajor: capabilities.protocolMajor, namespaceTools: capabilities.supportsNamespaceTools }, "Codex app-server started");

  let coordinator: SessionCoordinator | null = null;
  const messaging = new FeishuAdapter({
    appId: config.secrets.appId,
    appSecret: config.secrets.appSecret,
    domain: config.feishuDomain,
    store,
    onConnectionChange: (connected) => {
      logger.info({ connected }, "Feishu connection state changed");
      if (connected) void coordinator?.flushDeliveries();
    },
    onOutboundMessage: (message) => logger.info({ feishu: message }, "Feishu outbound message"),
  });
  coordinator = new SessionCoordinator(store, commandLogs, driver, messaging, config.secrets.actionSigningKey, {
    statusUpdateIntervalMs: config.statusUpdateIntervalMs,
    approvalTtlMs: config.approvalTtlMs,
    redactionPatterns: patterns,
  }, logger);

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info({ signal }, "PulseCortex shutting down");
      await coordinator?.stop().catch(() => undefined);
      await messaging.disconnect().catch(() => undefined);
      await driver.stop().catch(() => undefined);
      store.close();
    })();
    return shutdownPromise;
  };
  const installShutdownHandler = (signal: NodeJS.Signals) => {
    process.on(signal, () => { void shutdown(signal).finally(() => process.exit(0)); });
  };
  installShutdownHandler("SIGINT");
  installShutdownHandler("SIGTERM");
  installShutdownHandler("SIGHUP");
  if (process.platform === "win32") installShutdownHandler("SIGBREAK");
  else installShutdownHandler("SIGQUIT");

  const connect = async () => {
    let attempt = 0;
    while (!shuttingDown) {
      try {
        await messaging.connect();
        logger.info("Feishu long connection established");
        try { await coordinator?.initialize(); }
        catch (error) { logger.warn({ errorMessage: redact((error as Error).message, patterns) }, "Could not discover running Codex sessions at startup"); }
        return;
      }
      catch (error) {
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, attempt++)) * (0.5 + Math.random() * 0.5);
        logger.warn({ errorMessage: redact((error as Error).message, patterns), retryMs: Math.floor(delay) }, "Feishu connection failed; daemon remains active");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
  void connect();

  const retention = setInterval(() => {
    store.applyRetention(config.auditRetentionDays);
    void retainDailyLogs(config.logDir, config.logRetentionDays, config.logMaxBytes).catch((error) => logger.warn({ errorMessage: redact((error as Error).message, patterns) }, "daemon log retention failed"));
    void commandLogs.retain(config.logRetentionDays, config.logMaxBytes).catch((error) => logger.warn({ errorMessage: redact((error as Error).message, patterns) }, "command log retention failed"));
  }, 24 * 60 * 60_000);
  retention.unref();
  logger.info({ dataDir: config.dataDir, logDir: config.logDir }, "PulseCortex daemon ready");
}

main().catch((error) => {
  process.stderr.write(`PulseCortex failed to start: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
