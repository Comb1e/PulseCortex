# Feishu Setup

PulseCortex requires a Feishu enterprise self-built application with a bot.
A one-way custom webhook bot cannot receive owner commands or card actions.

1. In the [Feishu developer console](https://open.feishu.cn/app), create an
   **enterprise self-built application** and enable **Bot**.
2. Under API permissions, grant only:
   - Read direct messages sent to the bot: `im:message.p2p_msg:readonly`
   - Send messages as the application bot: `im:message:send_as_bot`
3. Do not grant group-message scopes. PulseCortex rejects group events.
4. Under **Events and Callbacks**, select **Long Connection** and subscribe to
   `im.message.receive_v1` and `card.action.trigger` (event and callback
   configuration respectively).
5. Publish an application version and initially restrict availability to the
   intended owner.
6. Copy the App ID and App Secret from **Credentials and Basic Information**
   into the restricted environment file created by `pulsectl init`.

Feishu may require a running client before it lets you save long-connection
delivery. Start `pulsecortex` (or `pnpm start` from a source checkout), save the
subscriptions, publish the app, and restart the daemon.

Official references:

- [Long-connection event delivery](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [Long-connection callback delivery](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address?lang=zh-CN)
- [Receive-message event and scopes](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [Send-message API and scopes](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [Card callback](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)

## Pair the Owner

Generate a six-digit, ten-minute code locally:

```powershell
pnpm pulsectl pair
```

Use `pulsectl pair` with the npm installation.

Send `/pair <code>` in a direct chat. A code has one active instance, expires automatically, and locks after five bad attempts. Pairing stores the tenant key, owner `open_id`, and direct-chat destination. Every later message and callback must match that owner.

To replace the owner, stop the daemon and deliberately remove the binding with a database migration or a future administrative command. V1 does not offer remote unpairing.

## Trial Checklist

Use a developer tenant before production:

1. Verify an unknown user and a group message receive no control response.
2. Run a harmless edit/test task and inspect its status, logs, and diff cards.
3. Exercise Allow once, Auto approve (commands only), Deny, Stop, and an
   expired approval.
4. Disconnect the network, confirm work continues and results queue, then
   reconnect and confirm delivery.
5. Restart during a turn and confirm it becomes `interrupted_unknown`.
6. Confirm the app-server listens only on loopback and install the shell
   integration before testing shared TUI sessions.
