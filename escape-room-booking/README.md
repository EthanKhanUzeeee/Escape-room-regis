# Escape Room Booking

Booking, matchmaking and QR check-in for a one-day escape room event with three rooms, plus a staff dashboard, a phone scanner for the door, a game timer for each room's game master and a leaderboard for the TV.

## What's in it

**Booking page** (`/`)
- Three ways to join: **Full Team** (6 players), **Small Group or Solo** (1–5, matched with other players in the same room), or **Private Room** (2–5 players who pay for all 6 spots).
- A grid of times (9:00–9:45 AM to 5:00–5:45 PM, so the day ends by 6 PM) by rooms (Lihim ni Lola, Night at the Museum, Containment Breach). Difficulty shows as padlocks. Rooms that can't fit the group are greyed out.
- A two-step form: team, leader contact and every player's name, then payment instructions, receipt upload and reference number.
- Small groups can share a Messenger, Facebook, Instagram or phone contact with the others in their room.

**Ticket page** (`/t/…`)
- Shows "Payment being checked" until staff approve. Then it shows the QR code.
- **Share with your group** sends the same link to the rest of the group, so anyone in the group can show the QR.
- Lists who checked in and who else is in the room.
- If a payment is rejected, the leader can upload a new receipt from this page.

**Emails**
- Booking received.
- QR ticket, after the payment is approved.
- Payment rejected, with your reason.
- Players missing, sent to the leader 10 minutes before start.
- Standby alert, sent to a walk-in when a spot opens.

**Staff dashboard** (`/staff`, one shared password)
- **Day board:** every time slot × room, showing booked, checked in and payments to review. The current time slot is pinned on the event day. Tap a room to see its players, tick them in, close check-in early, or give a spot to a walk-in.
- **Payments:** one receipt at a time. Approve sends the QR ticket; Reject asks for a reason and emails it. **Delete as spam** removes a fake booking without emailing anyone.
- **Bookings:** search, filter, move a booking to another room or time, resend emails, and download a CSV.
- **Standby:** add walk-ins who paid at the desk, see open spots, alert them, give them a spot, or mark them refunded. GCash and Maya payments need the reference number from the receipt, so a refund can go back to the right account.
- **Emails:** every email the app made, with a preview.
- **Settings:** event details, schedule, rooms, pictures, price, payment instructions, email, Google Sheet and password. **Clear all bookings** (two taps) removes every booking, receipt, walk-in, saved email and game result, for wiping test data before launch or after a rehearsal; settings and the password stay.

**Door scanner** (`/staff/scan`)
- The phone camera reads the QR code and shows a big **PAID** or **NOT PAID**, the room and time, and a checkbox for each player.
- Scan the same QR again for late arrivals.
- **Search** finds people without a QR. **Standby** gives open spots to walk-ins.

**Game master** (`/staff/games`, staff password)
- One phone or tablet per room. Pick your room once; the page remembers it and opens on the game that's running, or on the current time slot.
- It lists the games from 9:00 AM to 6:00 PM, the game masters' hours (`GM_HOURS` in `server.js`). Games booked outside those hours don't show here, so set Settings › Schedule to match.
- Before a game it lists who's booked into the room and how many checked in at the door. Teams sharing a room become one entry with their names joined, like "James & Thetaxers". Without a team name, a solo player shows by name and a group by its leader ("James's group").
- **Start · blindfolds off** starts the countdown at 45:00. If check-in is still open it asks first, then closes check-in, as reaching the start time does.
- **Pause** and **Resume** for an emergency or a broken prop. **Stop · team opened the exit** records the escape time. **Gave up** ends the game with no time.
- At 00:00 the game ends by itself with no escape time.
- **Undo** (for 10 minutes) puts a Stop or Gave up tapped by mistake back on the clock, counting the time since Start. **Edit result** fixes the time or the result. **Delete result** removes the game, so the room can be started again for that time.
- **Clues used** (a sub-feature, up to 3, no fourth): shown on the TV, never part of the ranking.
- The app's server times every game, so a phone that sleeps or reloads never changes a result. Where the browser allows it, the screen stays on while a game runs.

**TV leaderboard** (`/leaderboard`, no password)
- Open it on the laptop connected to the TV and click **Full screen**. The three rooms sit side by side: each room's top 6 with escape time (mm:ss) and clues used, medals for 1st to 3rd, and the game in the room right now with its time left.
- The whole board scales with the screen, so a 720p, 1080p or 4K TV shows the same layout at the same proportions. An upright screen or a phone gets the rooms stacked instead.
- It checks for new results every 5 seconds. A team that just made the board glows for a few seconds.

## The rules it follows

- Check-in closes when a time slot starts. Spots of players who haven't checked in then go to walk-ins on the standby list. Private rooms keep all 6 spots.
- Booked spots are non-refundable. Walk-ins who never get a spot are refunded and are marked **Refund due** after the event.
- Rooms run however many players show up.
- Full Team and Private Room need an empty room. Small groups fill rooms with enough open spots.
- A rejected payment releases the group's spots.
- To stop fake bookings from filling the rooms, each email and each mobile number can have 2 bookings waiting for payment review. One internet connection can book 10 times an hour and hold 36 spots waiting for review. Staff signed in to the dashboard are never limited. (When the app runs on a laptop shared through a tunnel, every visitor looks the same, so only the email and number limits apply there.)
- Ten wrong staff passwords lock out that one device or network for 10 minutes, not everyone.
- The leaderboard ranks each room by escape time in whole seconds, fastest first, and shows the top 6. When two teams have the same time, the earlier game ranks higher. Teams that ran out of time or gave up aren't ranked. Clues don't change the ranking.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

- **Windows, for real use:** double-click `start-online.bat` (see *Run it online* below).
- **Windows, just on this computer:** double-click `start.bat`. The first time, it installs the libraries.
- **Any system:** `npm install` once, then `node server.js`.

Then open:
- http://localhost:3000 for the booking page.
- http://localhost:3000/staff for the staff dashboard. The first staff password is in `data/STAFF-PASSWORD.txt`.

### Set up before you share the link

In the dashboard, open **Settings**:
1. Set the event date, venue, price per player and your GCash or bank details.
2. Check the schedule: first game 9:00, last game 17:00, 45-minute games, a new game every 60 minutes.
3. Write a line about each room and upload pictures and a poster when you have them. Until then the page shows placeholders.
4. Set your own staff password.
5. **Google (Drive, Gmail, Sheet):** follow the steps under *Connect Google* in Settings. One small Google Apps Script, made from your event Gmail, does three things:
   - stores the bookings, receipts and pictures in that account's Google Drive
   - sends the emails
   - keeps the Google Sheet up to date

   The dashboard gives you the script with your secret key already in it. A reference copy is in `google-connector.gs`.
6. Click **Move data to Google Drive** under *Where your data is stored*. From then on the data doesn't belong to any one computer.

## Where the data lives

| | This computer only | Google Drive (recommended) |
| --- | --- | --- |
| Bookings, settings, standby list | `data/db.json` | `Escape Room App Data/escape-room-data.json` in the event Google Drive, plus an hourly copy in its `Backups` folder |
| Receipts, poster, room photos | `data/files/` | `Escape Room App Data/Files/` |
| Who can run the app | only this computer | any laptop with the two-line `config.env` file, or a cloud host with the same two settings |

The `data` folder on each laptop is then just a cache.

Run only one copy at a time. Two copies saving at once overwrite each other's changes, so the dashboard warns you if it notices a second one.

`config.env` and the `data` folder are never uploaded to GitHub. Keep `config.env` private: anyone with those two lines can read and change the bookings.

## Option A: free cloud host, no laptop needed (recommended)

Render's free plan gives the app a fixed `https://….onrender.com` link, and the data stays in Google Drive.
1. Sign up at https://render.com with GitHub. No card is needed for the free plan.
2. Click **New › Blueprint**, pick this repository, and enter a staff password when asked. Render reads `render.yaml`, builds the app, and makes a secret key for you.
3. Open `https://<your-app>.onrender.com/staff` and sign in. Go to **Settings › Connect Google** and follow the steps. The script you copy already has the key and your Render link in it.
4. In Render, open your service › **Environment**, add `GOOGLE_SCRIPT_URL` with the web app link from step 3, and save. Render restarts the app, and from then on the data lives in Google Drive.
5. In the Apps Script editor, choose **installKeepAwake** and click **Run** once. Free Render apps sleep after 15 quiet minutes and take about a minute to wake up; this keeps it awake.

## Option B: run it from any laptop (free)

People book from their own phones, and phones only allow the camera on secure (`https`) pages. Tailscale Funnel gives a laptop a free, fixed `https://…ts.net` link that doesn't change when you restart. Each laptop has its own link, so pick one laptop to run it during booking and the event. If that laptop breaks, another one with `config.env` picks up the same data. Ticket links already emailed point to the first laptop's address, but the QR codes still scan.

One-time setup on that laptop:
1. Install Tailscale from https://tailscale.com/download and sign in. A personal Google account is fine and is free.
2. In the Tailscale admin console (https://login.tailscale.com/admin), allow **Funnel** for your account when asked. The first run of `start-online.bat` also prints this link.
3. Set this laptop to **never sleep while plugged in**: Settings › System › Power.

Every time:
- Double-click **`start-online.bat`**. It turns on the Funnel, starts the app with your public link, and restarts the app if it ever stops. The window shows your booking link and scanner link, and so does the **Links** panel on the staff dashboard.
- Keep that window open, and keep the laptop on and online, from the day booking opens until the event ends.

Then test from a phone on mobile data (not your Wi-Fi): open the booking link, and open `/staff/scan` to check the camera.

### Scanning at the door

- **Scanner page:** `/staff/scan` on the public link. Staff sign in once on their phones.
- **No scanner page?** Staff can scan a ticket QR with the phone's normal camera app. Because they're signed in, the ticket page opens with a **Staff check-in** panel on top.

### Other hosts

Any Node host works: start command `npm install && node server.js`, with `GOOGLE_SCRIPT_URL`, `GOOGLE_SECRET`, `STAFF_PASSWORD` and `PUBLIC_URL` (the host's https address) set in its environment settings. Many hosts block normal email sending (SMTP) on cheap plans. The Google connector sends over https, so it still works there.

## Settings you can pass

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer |
| `DATA_DIR` | `./data` | The local data folder (or, with Google Drive storage, the local cache) |
| `GOOGLE_SCRIPT_URL` | (unset) | The Google connector link. With `GOOGLE_SECRET`, the data lives in Google Drive |
| `GOOGLE_SECRET` | (unset) | The key shared with the Google script |
| `STAFF_PASSWORD` | generated | The first staff password, used only if none is saved yet. Add `STAFF_PASSWORD_RESET=1` to force it |
| `PUBLIC_URL` | (unset) | The app's public https address for ticket links and QR codes. `start-online.bat` and Render set it for you |
| `FAKE_NOW` | (unset) | For rehearsals only: pretend it's a given time, like `2026-12-13T09:50` |

Any of these can also go in a `config.env` file next to `server.js`, one `NAME=value` per line.

## Privacy

The data holds personal details and payment receipts. Only signed-in staff can see receipts, contact details and the Emails tab, and players only ever see their own ticket. With Google Drive storage, the `Escape Room App Data` folder is private to the event Google account unless you share it. Delete it after the event, along with the Google Sheet.
