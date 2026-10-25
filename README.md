# Faucet Beacon 💧

Render hosting: [step-by-step setup guide](RENDER_SETUP.md). The included `render.yaml` deploys one paid Docker Background Worker for both configured servers.

A Discord faucet for **Interlink ITL Testnet**, paying native **tITL** from one shared funding wallet across an operator-approved list of Discord servers. Built with TypeScript, discord.js, ethers and the **FaucetBot Supabase database**.

Users can post a wallet address or use `/faucet claim`. Distribution works only in channels approved by an administrator. The default cooldown is **6 hours** per wallet **and** Discord account, shared across every server. There are **120 cooldown quotes and 120 success quotes**, including the Mercedes, BMW, Lambo and mansion jokes.

## Start here

1. Install **Node.js 22.16 or newer**. Use a current Node 22 LTS release for deployment.
2. Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications).
3. On its **Bot** page, enable **Message Content Intent**. It is required for wallet detection in ordinary chat. Server Members Intent is not needed.
4. Invite the bot using scopes **bot** and **applications.commands**. Give it **View Channel**, **Send Messages**, **Embed Links**, **Attach Files**, and **Read Message History**. It does not need the Administrator permission itself.
5. Open the [FaucetBot SQL Editor](https://supabase.com/dashboard/project/pypehbsuhuhnutxkphyf/sql/new), paste the **entire** [supabase/schema.sql](supabase/schema.sql), and run it. The script can be run again and finishes with `schemaVersion: 3` and `initialized: false` before the first bot startup. Before starting the bot, you can also run [supabase/verify.sql](supabase/verify.sql) to exercise the database rules with temporary test records that are rolled back.

6. Copy `.env.example` to `.env` if you do not already have one, and configure these values **locally**:

   ```dotenv
   DISCORD_TOKEN=your_bot_token
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_GUILD_IDS=your_first_server_id,your_second_server_id
   FAUCET_PRIVATE_KEY=0x_your_dedicated_faucet_wallet_private_key
   SUPABASE_URL=https://pypehbsuhuhnutxkphyf.supabase.co
   SUPABASE_SECRET_KEY=your_server_secret_key
   ```

   Get the server secret key from [FaucetBot API Keys](https://supabase.com/dashboard/project/pypehbsuhuhnutxkphyf/settings/api-keys). Use an `sb_secret_...` key, or a legacy `service_role` key. A publishable/anon key will not work. Do not paste these secrets into Discord or a chat. Enable Discord Developer Mode to copy your server ID. The bot keeps wallet keys and gateway JWTs out of Supabase.

7. Run:

   ```powershell
   npm ci
   npm run build
   npm run db:doctor
   npm run doctor
   npm start
   ```

   `db:doctor` checks Supabase and the installed schema; it needs only the Supabase settings. `register` installs the three command groups in every allowlisted server the bot has joined. Normal startup also registers them automatically, including when the bot joins an allowlisted server later. `doctor` verifies gateway login and prints the funding wallet's public address and balance; it sends no transaction. After building, the same diagnostics can run directly with `node dist/db-doctor.js` and `node dist/doctor.js`.

8. Fund the wallet with native **tITL**, keeping a little extra for gas. In Discord:

   ```text
   /faucet-admin channel-add channel:#faucet
   /faucet-admin amount amount:0.1
   /faucet-admin cooldown hours:6
   /faucet-admin wallet
   /faucet-admin start
   ```

The first run is **paused**, with no approved channels. A later restart preserves the configured amount, status, permissions, channels, bans, queue and cooldowns. Only servers in `DISCORD_GUILD_IDS` can use the faucet, even if somebody invites it elsewhere. The legacy `DISCORD_GUILD_ID` setting still works for a single server when the list is unset. Each server has its own amount, start/stop, approved channels, blacklist, role grants, CSV batches and daily budget. The funding wallet, payout worker, transaction nonce, wallet/account reservations and cooldowns are shared.

**Hinglish quick guide:** Pehle `supabase/schema.sql` ka poora SQL FaucetBot project mein run karo. `.env` mein Supabase secret key, bot token, application ID, comma-separated server IDs aur faucet wallet key locally daalo. `npm run db:doctor` se database check karo. Wallet mein tITL bhejo. Admin channel add kare, amount set kare aur `/faucet-admin start` chalaye. Us approved channel mein user address likhega to faucet milega.

## Multiple servers and upgrading from version 2

Set `DISCORD_GUILD_IDS` to a comma-separated list of the servers the wallet operator trusts. Invite the same bot to each server and enable Message Content Intent in the Developer Portal. One process and one funding wallet serve the entire list. On startup, commands register automatically in joined servers; an allowlisted server invited later gets commands when it joins. New servers start paused with no approved channels and the `DEFAULT_AMOUNT` value (0.1 tITL by default). An admin configures and starts each server separately. Changing `DEFAULT_AMOUNT` later does not overwrite saved server settings; use `/faucet-admin amount` there.

If the database already has schema version 2, stop the old bot, run the complete current `supabase/schema.sql`, and then deploy the new build. The script adds guild ownership, preserves existing records and cooldowns, and upgrades the schema to version 3. For a database that has never been initialized, run `supabase/verify.sql` before first startup; it covers shared cooldowns and reservations, server isolation, the global worker lease, and rollback. Do not run that verification script on an initialized live database.

Server admins and delegated moderators control only their own server. A claim's cooldown applies across all servers for the recorded duration, so switching servers does not reset it. Queued and signed wallet/account reservations are also global. CSV budgets and rolling daily totals belong to the requesting server; all servers spend from the same wallet balance. Before removing a server from the allowlist, pause it and cancel its unsigned queued payouts. Signed payouts always retain their global reservation until resolved.

## User commands

| Command | What it does |
|---|---|
| `/faucet claim address:0x…` | Queue a claim in an approved channel |
| `/faucet status` | Show amount, cooldown, availability and queue count |
| `/faucet help` | Explain claims and show approved channels |

Automatic claims accept exactly one wallet address per message. Bots, webhooks, DMs, servers outside the operator allowlist and unapproved channels are ignored. Threads do not inherit their parent channel's approval; this version approves regular text and announcement channels. Status/help replies are private and can be used elsewhere in the configured server. Admin and moderation commands can also be used there, while all payout requests require an approved channel.

`/faucet claim` and automatic wallet claims show a **public In progress card** with a bundled animated loading ring. The card updates as the transfer is submitted and confirmed, and shows a delay message if the network takes longer than two minutes. After confirmation, loading is replaced with a completed card and a new public success message **pings only the claimant**, with a funny quote, amount, recipient wallet, next claim time and an **Interlink Explorer link/button**. Early attempts receive a funny quote and the real cooldown expiry. Repeated ordinary-chat errors are limited to one reply per user/channel every 15 seconds to avoid flooding.

## Admin controls

The human running these commands must have Discord's **Administrator** permission. A role merely named "admin" is insufficient. Discord command visibility is restricted, and permissions are also verified by the bot.

| Command | Purpose |
|---|---|
| `/faucet-admin channel-add channel:#faucet` | Approve one exact channel after checking the bot's permissions |
| `/faucet-admin channel-remove channel:#faucet` | Remove approval and cancel unsigned jobs there when checked |
| `/faucet-admin channels` | List approved channels |
| `/faucet-admin amount amount:0.5` | Change the amount for future public claims |
| `/faucet-admin cooldown hours:6` | Change the cooldown for future payouts |
| `/faucet-admin start` | Verify the gateway and balance, then resume |
| `/faucet-admin stop` | Pause intake and unsigned payouts |
| `/faucet-admin auto-claim enabled:false` | Disable wallet scanning while keeping slash claims |
| `/faucet-admin wallet` | Show the public funding address and balance |
| `/faucet-admin limits` | View per-wallet, per-batch and rolling daily limits |
| `/faucet-admin pending` | Show queued and submitted payouts with their IDs/hashes |
| `/faucet-admin cancel-queued payout-id:…` | Cancel one unsigned payout |
| `/faucet-admin recheck` | Sign in again and check the original pending transaction |
| `/faucet-admin roles` | Show delegated role permissions |

Limits can be updated together or individually:

```text
/faucet-admin limits per-wallet:10 per-batch:100 per-day:1000 batch-rows:100
```

The defaults are 0.1 tITL per claim, a 10 tITL per-wallet ceiling, 100 tITL per CSV, 1,000 tITL across a rolling 24-hour window, and 100 CSV rows. Payout budgets count confirmed payments and outstanding reservations; network gas is separate. Set limits to suit the funded wallet. To set a claim amount above the current ceiling, first increase `per-wallet`.

Changes to amounts and cooldowns apply to future requests. Existing queued payouts retain their agreed amounts and cooldowns, but current bans, channel approval, moderator permissions and budget ceilings are checked again before submission. Existing cooldowns retain their original expiry.

## Delegate exactly what moderators need

Permissions are granted separately, and a member inherits the union of grants from their roles. Administrators already have all capabilities.

```text
/faucet-admin role-grant role:@FaucetMods permission:blacklist
/faucet-admin role-grant role:@FaucetMods permission:bulk
/faucet-admin role-grant role:@FaucetMods permission:cooldown

/faucet-admin role-revoke role:@FaucetMods permission:bulk
```

| Permission | Enables |
|---|---|
| `blacklist` | Timed blacklist, remove blacklist, list blacklist |
| `bulk` | CSV preview, confirmation, batch status and reports |
| `cooldown` | Set the default cooldown; choose custom hours for a CSV if the role also has `bulk` |

Moderators do not gain access to approving channels, role grants, public claim amounts, budgets or start/stop. `@everyone` and managed integration roles cannot be granted these permissions.

### Timed blacklist

```text
/faucet-mod blacklist-add address:0x… hours:24 reason:Repeated abuse
/faucet-mod blacklist-remove address:0x…
/faucet-mod blacklist-list
/faucet-mod cooldown hours:6
```

Fractional hours work: `0.5` is 30 minutes. Durations range from `0.01` to `8760` hours. Bans expire automatically. Removing a ban does not erase a claim cooldown. Blacklists also apply to CSV recipients, so a bulk permission cannot bypass them.

### CSV distribution

Use a UTF-8 `.csv` with one wallet per row:

```csv
address
0x1111111111111111111111111111111111111111
0x2222222222222222222222222222222222222222
```

These are example addresses. Replace them with actual recipient addresses. A headerless one-column list also works. Recognized headers are `address`, `wallet`, `wallet_address` and `walletAddress`. With a header, extra columns are ignored; the amount always comes from the Discord command.

```text
/faucet-mod bulk csv:<upload addresses.csv> amount:1 cooldown-hours:6
```

- The amount is **per unique wallet**, not the batch total.
- The preview shows the exact recipient count, payout total plus gas, cooldown and sample addresses. Duplicate rows are removed and counted.
- Only the uploading moderator can press **Confirm payouts**, in the same channel, within 10 minutes.
- Invalid addresses reject the file. Blacklists, cooldowns, pending claims, roles and budgets are checked again on confirmation. Admission is all-or-nothing; an ineligible recipient prevents the entire preview from being queued.
- Blockchain transfers settle individually. A batch may be partly completed if funds run low or rules change; remaining jobs pause or cancel as appropriate. Refilling the wallet and using `start` resumes paused jobs.
- Omit `cooldown-hours` to use the current default. Setting it explicitly requires both `bulk` and `cooldown` permissions.
- The maximum attachment size is 256 KB; the row cap is controlled by the admin, up to 1,000.

Track or download the report:

```text
/faucet-mod batch-status batch-id:<ID from preview>
```

The report contains every address, exact amount, state, transaction hash, explorer URL and error code. Every confirmed transfer also gets its own public success embed.

## Interlink integration

| Setting | Value |
|---|---|
| Network | ITL Testnet |
| Chain ID | **19042026 / 0x1228eea** |
| Native currency | **tITL**, 18 decimals |
| Gateway base | `https://evm-rpc.test-net.interlinklabs.ai/v1` |
| JSON-RPC | `/v1/rpc`, with a Bearer access token |
| Explorer | `https://explorer.test-net.interlinklabs.ai` |
| Confirmations | 3 by default |

The actual gateway returned `0x1228eea`; the earlier supplied `0x1228aea` converts to a different decimal ID. Startup verifies the chain before signing transfers. Explorer links are generated normally, but Interlink may currently make the explorer accessible only from its app.

The authentication schema was verified against the live gateway on **24 October 2026**, using a temporary unfunded wallet:

1. `POST /auth/challenge` with `{ "walletAddress": "0x…", "chainId": "19042026" }`. The chain ID is a **string**.
2. Read `result.challengeId` and `result.messageToSign`. The header says `interlinklabs.ai wants you to sign in with your Interlink account:`.
3. Verify domain, address, chain, verification URI, nonce, request ID and message lifetime. Normalize the unusual account label only for SIWE parsing; sign the **unchanged server message**.
4. `POST /auth/verify` with `{ "walletAddress": "0x…", "challengeId": "…", "signature": "0x…" }`.
5. Read `result.accessToken`, `result.refreshToken` and `result.accessTokenExpiresInSec`. Store them only in process memory.
6. Refresh before expiry, or once after HTTP 401, via `POST /auth/refresh` with `{ "refreshToken": "…" }`. A failed refresh clears the session and requires an admin `start` or `recheck`.

Rate limits use bounded exponential backoff and jitter. The bot uses the supported native-transfer RPC methods, reads only the authenticated funding wallet's balance/nonce, and requests blocks with `fullTransactions=false`. It signs EIP-1559 transactions locally and submits `eth_sendRawTransaction`. It sends **native tITL only**, with no token contract or arbitrary calldata.

`MAX_FEE_PER_GAS_GWEI` and `MAX_GAS_LIMIT` cap network fees. Low balance, excessive fees, authentication errors or a transaction needing review pause payouts across all servers sharing the wallet. An ordinary admin stop affects only that admin's server. `CONFIRMATIONS` can be set from 1 to 12; the default of 3 matches the recommended app flow.

## Persistence and recovery

Supabase is the authoritative store for settings, approved channels, role grants, timed blacklists, cooldowns, CSV previews, payouts and audit records. The project is **FaucetBot** (`pypehbsuhuhnutxkphyf`, Mumbai region). Amounts use Postgres `numeric(78,0)` integer wei and cross the API as strings, preserving 18-decimal precision. The database contains no wallet private key, Discord token or gateway JWTs. Use Supabase backups for these records; the bot has no local database fallback.

All application tables have RLS enabled. Tables and RPC functions are inaccessible to `anon` and `authenticated`; the trusted bot uses a server credential. Discord identities and current role membership are resolved by the bot, then atomic Postgres functions enforce the channel, moderator capability, blacklist, cooldown and budget rules. Every server-specific read and write is scoped by guild ID, including reports, blacklist entries, moderator grants and cancellations. Never embed this server credential in a frontend or Discord message.

Admission and state changes serialize with a Postgres advisory lock. Unique indexes reserve each wallet and public claimant and allow only one signed/broadcast/review transaction at a time. A renewable, fenced **three-minute database lease** chooses the active payout worker. After an unclean shutdown, a replacement worker waits for the lease to expire; a clean shutdown releases it. Run one Discord instance for all configured servers normally, and keep the dedicated funding wallet exclusive to this bot to avoid external nonce changes.

Each Discord message/interaction and each confirmed CSV row has a unique request key. Wallet and user reservations are durable. The exact signed transaction, nonce and deterministic hash are saved **before** network submission. After a crash or uncertain RPC response, the worker checks that same transaction and can rebroadcast the same signed bytes; it does not blindly create a second payment.

Incoming claims run through a bounded queue: **8 concurrent checks and 100 waiting requests** by default, with a maximum 60-second wait before admission. Configure these with `REQUEST_CONCURRENCY`, `REQUEST_QUEUE_LIMIT`, and `REQUEST_QUEUE_WAIT_MS`. One user can occupy only one slot at a time. Full or expired requests receive a busy response without creating a claim; already accepted payouts remain in Supabase. Admin/status commands have a separate small queue. The wallet still settles one transfer at a time, so a large burst increases payment wait times. These limits bound application work; they are not a production throughput guarantee for Discord, Supabase or the chain.

Temporary database reads retry at most twice with backoff. Writes are never automatically replayed. When a claim write has an uncertain response, the bot looks up its original Discord request ID and recovers an accepted claim; if the result remains unknown, it says **Checking your request** instead of claiming it was rejected. After acceptance, message-display or audit-reference failures cannot turn it into a rejected claim. Empty successful PostgREST insert responses, including HTTP 201, are handled as success. Unchanged progress cards avoid repeated per-payout database reads, and each worker cycle limits progress updates so a notification backlog cannot monopolize payout processing.

`stop`, blacklist changes and channel removal cannot recall a transaction that has already been signed/submitted. Those transactions continue through receipt checking. The bot waits for the configured confirmations before announcing success and starting the cooldown.

If a nonce is already consumed but the original receipt is temporarily invisible, the bot retains the reservation and pauses for review. Use `pending` and `recheck`; when the original receipt becomes visible, it settles automatically. A permanently replaced transaction requires operator investigation with Interlink. Do not clear reservations or manually resend just because an RPC request timed out. Submitted transactions are never automatically replaced with a different fee or destination.

Discord delivery retries are independent of payouts. Progress and result message references are saved in the existing backend-only audit table, so restarts can update the original card and avoid reposting acknowledged successes. Deterministic Discord nonces also deduplicate recent sends. A crash between posting an embed and saving its reference can still repeat an embed after Discord's deduplication window expires, but cannot repeat the transfer. A Supabase outage prevents new signatures from being submitted without a durable database record. The worker resumes from the saved transaction after recovery; uncertain writes are never automatically replayed as new claims. Settings and cooldowns survive container rebuilds because they remain in Supabase.

## Low-balance alerts

Server administrators can configure a dedicated alert channel and any combination of users and roles. Alerts are disabled until configured and at least one recipient is added. Configuration and notification state survive restarts in the existing Supabase schema; no SQL update is required.

```text
/faucet-admin alerts setup channel:#faucet-alerts below:1 repeat-hours:6
/faucet-admin alerts target-add user:@Anish
/faucet-admin alerts target-add role:@FaucetAdmins
/faucet-admin alerts status
/faucet-admin alerts test
```

Repeat `target-add` for each recipient (up to 20 users and roles combined). Choose exactly one user or role per command. Roles need to be mentionable, or the bot needs **Mention @everyone, @here, and All Roles** in that alert channel; the bot's message permits only the configured role/user IDs, never automatic `@everyone` or `@here`. The alert channel needs View Channel, Send Messages, Embed Links and Read Message History. Alert recipients do not gain faucet management permissions.

The shared wallet balance is checked once per minute, including while payouts are paused. Each server has its own threshold, channel and recipients. A balance **strictly below** the threshold triggers an alert with the observed balance, threshold and funding address. Reminders default to six hours; set `repeat-hours:0` to send only once until a refill brings the balance back to or above the threshold. A subsequent drop then triggers a new alert. Other reminder intervals must be 1–168 hours. RPC errors do not count as zero balance, and failed notifications do not stop payouts.

```text
/faucet-admin alerts target-remove user:@Anish
/faucet-admin alerts target-remove role:@FaucetAdmins
/faucet-admin alerts targets-clear
/faucet-admin alerts disable
```

Run `setup` again to change the threshold/channel or re-enable alerts. `test` deliberately posts a clearly labelled test and pings the configured recipients even if the balance is healthy; it does not change the normal alert cooldown. Notification retries reuse a durable event ID and check recent channel messages before reposting after an uncertain Discord response.

## Docker / always-on deployment

After configuring `.env`:

```sh
docker compose build
docker compose run --rm faucet node dist/db-doctor.js
docker compose run --rm faucet node dist/register.js
docker compose run --rm faucet node dist/doctor.js
docker compose up -d
docker compose logs -f faucet
```

The container runs as a non-root user and needs outbound HTTPS access to Discord, Supabase and the Interlink gateway. There is no database volume to mount. Stopping the container preserves the running/paused setting in Supabase; use the Discord `stop` command first when you want it to remain paused after restart.

## Development and checks

```sh
npm run typecheck
npm test
npm run build
npm run dev
```

Automated TypeScript tests cover local identity and input validation, Supabase request/error handling, exact amounts, quote rotation, gateway authentication/refresh, rate limiting, offline EIP-1559 signing, worker leases, uncertain database writes/submissions, pause/cancel races and notification retries. They use simulated database and chain responses and do not move funds. The test runner compiles with TypeScript and runs in one Node process.

Database admission, grants, constraints and cooldown behavior have a separate [SQL verification script](supabase/verify.sql). Run it in the SQL Editor **after schema installation and before the first configured bot startup**. It refuses an initialized database, takes the application lock, creates test records inside a transaction and rolls them back. Local TypeScript tests alone do not validate the installed Postgres functions. For a database that is already running, run this verification against a separate test database with the same schema.

For a read-only live gateway check without your bot secrets:

```sh
npm run probe:gateway
```

This uses the production gateway client with a temporary wallet, checks authentication and permitted reads, and advances only its local token-expiry clock to test refresh. It never funds the wallet, saves its key or signs a transaction.

A successful database or gateway diagnostic does not confirm a Discord payout. Start with a small test claim in the approved channel and check its receipt.

## Project map

```text
src/chain/          SIWE/JWT gateway and EIP-1559 native transfers
src/discord/        Slash commands, permission checks and embeds
src/content/       240 hand-written, shuffled humorous quotes
src/service.ts     Discord identity and input validation; atomic database calls
src/supabase-store.ts  Server-scoped Supabase RPC client, shared wallet worker
src/engine.ts      Leased payout worker, recovery and delivery retries
supabase/          Complete schema and rollback-only database checks
test/              Transport, service, gateway and worker tests
examples/          CSV format example
scripts/           Read-only live gateway probe
```
