# Feishu Application Setup

PulseCortex requires an application bot. A one-way custom webhook bot cannot receive owner commands or card actions.

1. In the Feishu developer console, create an **enterprise self-built application**.
2. Under application capabilities, enable **Bot**.
3. Under API permissions, grant only these application scopes:
   - Read direct messages sent to the bot: `im:message.p2p_msg:readonly`
   - Send messages as the application bot: `im:message:send_as_bot`
4. Do not grant group-message scopes. PulseCortex rejects group events even if the application later receives one.
5. Under Events and Callbacks > Event Configuration, select **long connection** delivery and subscribe to `im.message.receive_v1`.
6. Under Events and Callbacks > Callback Configuration, select **long connection** delivery and subscribe to the new `card.action.trigger` callback. Do not select the legacy `card.action.trigger_v1` callback.
7. Publish an application version and make the bot available only to the intended owner during initial testing.
8. Obtain App ID and App Secret from Credentials and Basic Information. Put them only in the local restricted environment file or service-manager environment.

Feishu may require a running long-connection client before it lets you save long-connection delivery. Start `pnpm start`, save the event and callback subscription, then restart the daemon after publishing.

Official references:

- [Long-connection event delivery](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [Long-connection callback delivery](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address?lang=zh-CN)
- [Receive-message event and scopes](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [Send-message API and scopes](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [Card callback](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)

## Pairing

Generate a six-digit, ten-minute code locally:

```powershell
pnpm pulsectl pair
```

Send `/pair <code>` in a direct chat. A code has one active instance, expires automatically, and locks after five bad attempts. Pairing stores the tenant key, owner `open_id`, and direct-chat destination. Every later message and callback must match that owner.

To replace the owner, stop the daemon and deliberately remove the binding with a database migration or a future administrative command. V1 does not offer remote unpairing.

## Trial Checklist

Use a developer tenant before production:

1. Pair the owner and verify an unknown user receives no control response.
2. Verify group messages do not start work.
3. Select a project, run a harmless edit/test task, and inspect status, logs, and diff cards.
4. Exercise Allow once, Deny, and Stop on approval cards.
5. Disconnect internet temporarily, allow Codex to continue, reconnect, and verify queued milestones/results arrive.
6. Restart during a turn and verify the turn becomes `interrupted_unknown` rather than completed.
7. Verify the Codex app-server TCP listener is bound only to the configured loopback address, and that no PulseCortex port is reachable from another machine.
8. Install the shell integration with `pnpm pulsectl shell install`, open a new terminal, and launch ordinary `codex` from a registered project or one of its subdirectories. Without restarting PulseCortex, verify Feishu announces the loaded session within a few seconds. Send `/send <message>` and confirm the running session is steered; then select another session through `/sessions` and repeat.
9. Create at least four sessions and verify `/sessions` shows three at a time, caps previews at 100 words, and exposes Show more navigation.
