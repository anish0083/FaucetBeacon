# FaucetBeacon: GitHub se Render hosting

GitHub code store karta hai. Bot Render ke **Background Worker** par chalega. Ek worker dono servers ko serve karega; wallet aur cooldown shared hain. Supabase mein existing payouts, settings aur cooldowns preserved rahenge.

## 1. Second server mein invite

Application ID: `1563942179502555186`. Invite scopes: `bot`, `applications.commands`. Permissions: View Channel, Send Messages, Embed Links, Attach Files, Read Message History. Developer Portal mein **Message Content Intent** enabled rehna chahiye.

[Second server invite link](https://discord.com/oauth2/authorize?client_id=1563942179502555186&scope=bot%20applications.commands&permissions=117760&guild_id=1457514569739276561&disable_guild_select=true)

```text
DISCORD_GUILD_IDS=1504044542842900481,1457514569739276561
```

Bot join hone par allowlisted server ke commands automatically register honge. Har server ke approved channels, amount, controls aur alerts alag configure honge.

## 2. Render ka plan

[Render Dashboard](https://dashboard.render.com/) par GitHub se login karo. **Background Workers free tier par available nahi hain.** Blueprint `0.5c-512mb` paid compute use karta hai, listed price approximately **US$7/month**, excluding additional usage/taxes. Apply se pehle dashboard ka current price review karo.

One worker, one instance, Singapore region rakho. Is bot ke liye PORT ya HTTP health-check endpoint nahi chahiye.

## 3. Local bot stop karo

Render ka first deployment start karne se just pehle local PowerShell mein:

```powershell
cd C:\Users\Anish\Desktop\FaucetBeacon
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1
```

Ye saved PID/start time verify karke local bot stop karta hai. Agar separate `npm start`/`npm run dev` terminal bhi chal raha hai, use Ctrl+C se close karo. Same Discord bot ko local aur Render dono par simultaneously mat chalao. Render worker old lease expire hone tak maximum three minutes wait kar sakta hai; pending transaction cancel/resend mat karna.

## 4. Blueprint deploy (recommended)

1. Render Dashboard → **New + → Blueprint**.
2. GitHub authorize karke private **FaucetBeacon** repository ka access allow karo.
3. Repo aur branch **main** select karo; Blueprint path **render.yaml** confirm karo.
4. Render teen secrets maangega. Local `.env` se same values Render ke secret fields mein paste karo:

   | Render key | Local value |
   | --- | --- |
   | `DISCORD_TOKEN` | Existing bot token |
   | `FAUCET_PRIVATE_KEY` | Same funding wallet ki private key |
   | `SUPABASE_SECRET_KEY` | Existing Supabase server key |

   Secrets chat, GitHub, YAML ya screenshots mein mat daalna. Non-secret values Blueprint mein already hain. Same funding wallet use karo jo existing database se linked hai.

5. **Background Worker**, **0.5 CPU / 512 MB**, **Singapore**, **1 instance** aur price verify karke **Deploy/Apply** karo.
6. Build mein `npm ci` aur `npm run build` complete honge. Docker startup `node dist/index.js` hai.
7. Runtime logs check karo:

   ```text
   Commands ready in server 1504044542842900481.
   Commands ready in server 1457514569739276561.
   Faucet Beacon connected as FaucetBeacon#4268.
   ```

   `Awaiting an invite to allowlisted server ...` aaye to us server mein bot invite karo.

Automatic deploys abhi off hain. Future GitHub changes ke baad Render → service → **Manual Deploy → Deploy latest commit** use karo.

## 5. Manual Background Worker alternative

**New + → Background Worker** → GitHub repo connect karo:

| Setting | Value |
| --- | --- |
| Name | faucet-beacon |
| Branch | main |
| Runtime/Language | Docker |
| Dockerfile | ./Dockerfile |
| Docker context | Repository root (.) |
| Region | Singapore |
| Compute | 0.5 CPU / 512 MB paid plan |
| Instances | 1 |

Environment mein teen secrets ke saath ye values add karo:

```text
DISCORD_CLIENT_ID=1563942179502555186
DISCORD_GUILD_IDS=1504044542842900481,1457514569739276561
SUPABASE_URL=https://pypehbsuhuhnutxkphyf.supabase.co
DEFAULT_AMOUNT=0.1
DEFAULT_COOLDOWN_HOURS=6
NODE_ENV=production
```

Remaining chain/RPC settings code defaults se load honge. Dockerfile Build/Start handle karta hai. Separate Render database, Redis, disk ya cron ki zaroorat nahi.

## 6. Second server setup

Second server mein administrator account se actual faucet channel select karke:

```text
/faucet-admin channel-add channel:#faucet
/faucet-admin amount amount:0.1
/faucet-admin cooldown hours:6
/faucet-admin wallet
/faucet-admin start
```

`wallet` se funding verify karke start karo. Existing server ke saved settings preserve hote hain; environment defaults existing settings overwrite nahi karte.

Optional alerts:

```text
/faucet-admin alerts setup channel:#faucet-alerts below:1 repeat-hours:6
/faucet-admin alerts target-add role:@FaucetAdmins
/faucet-admin alerts test
```

Role mentionable ho ya bot ke paas alert channel ki role-mention permission ho. Individual recipients ke liye `target-add user:@Admin` use karo.

## 7. Verify

Approved channel mein one small claim test karo. Public progress → success message → explorer receipt verify karo. Shared cooldown ki wajah se same account/wallet server badal kar turant second claim nahi le sakta.

Existing Supabase schema version 3 installed hai. Hosting migrate karte waqt SQL reset ya `verify.sql` rerun nahi karna. `verify.sql` initialized live database ke liye nahi hai.

Local fallback chahiye to pehle Render worker suspend/stop karo, phir local bot start karo. Ek deployment active rakho.

Sources: [Background workers](https://render.com/docs/background-workers), [Free instances](https://render.com/docs/free), [Blueprint specification](https://render.com/docs/blueprint-spec), [Pricing](https://render.com/pricing).
