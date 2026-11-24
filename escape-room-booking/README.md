# Escape Room Booking

Booking, matchmaking and QR check-in for a one-day escape room event with three rooms, plus a staff dashboard and a phone scanner for the door.

## What's in it

**Booking page** (`/`)
- Three ways to join: **Full Team** (6 players), **Small Group or Solo** (1–5, matched with other players in the same room), or **Private Room** (2–5 players who pay for all 6 spots).
- A grid of times (9:00–9:45 AM to 7:00–7:45 PM) by rooms (Abandoned House, Night at the Museum, Resident Evil). Difficulty shows as padlocks. Rooms that can't fit the group are greyed out.
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
- **Payments:** one receipt at a time. Approve sends the QR ticket; Reject asks for a reason and emails it.
- **Bookings:** search, filter, move a booking to another room or time, resend emails, and download a CSV.
- **Standby:** add walk-ins who paid at the desk, see open spots, alert them, give them a spot, or mark them refunded.
- **Emails:** every email the app made, with a preview.
- **Settings:** event details, schedule, rooms, pictures, price, payment instructions, email, Google Sheet and password.

**Door scanner** (`/staff/scan`)
- The phone camera reads the QR code and shows a big **PAID** or **NOT PAID**, the room and time, and a checkbox for each player.
- Scan the same QR again for late arrivals.
- **Search** finds people without a QR. **Standby** gives open spots to walk-ins.

## The rules it follows

- Check-in closes when a time slot starts. Spots of players who haven't checked in then go to walk-ins on the standby list. Private rooms keep all 6 spots.
- Booked spots are non-refundable. Walk-ins who never get a spot are refunded and are marked **Refund due** after the event.
- Rooms run however many players show up.
- Full Team and Private Room need an empty room. Small groups fill rooms with enough open spots.
- A rejected payment releases the group's spots.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

- **Windows:** double-click `start.bat`. The first time, it installs the libraries.
- **Any system:** `npm install` once, then `node server.js`.

Then open:
- http://localhost:3000 for the booking page.
- http://localhost:3000/staff for the staff dashboard. The first staff password is in `data/STAFF-PASSWORD.txt`.

### Set up before you share the link

In the dashboard, open **Settings**:
1. Set the event date, venue, price per player and your GCash or bank details.
2. Check the schedule: first game 9:00, last game 19:00, 45-minute games, a new game every 60 minutes.
3. Write a line about each room and upload pictures and a poster when you have them. Until then the page shows placeholders.
4. Set your own staff password.
5. **Email:** use a Gmail account. Turn on 2-Step Verification, create an **App password** (Google Account › Security › App passwords), and paste the 16 letters into Settings. Use the Test email box to check it. Until then, emails are saved in the Emails tab instead of being sent.
6. **Google Sheet:** follow the four steps under *Connect the Google Sheet*. The dashboard gives you the script with your secret key already in it. A reference copy is in `google-sheet-sync.gs`.

## Putting it online (needed for the phone scanner)

Phones only allow the camera on secure (`https`) pages. People also need to reach the booking page from their own phones, for days before the event. So before you open bookings, put the app online:

- **A Node host** (Render, Railway, Fly.io or a small VPS): start command `npm install && node server.js`. Attach a persistent disk and set `DATA_DIR` to it, or bookings are lost when the host restarts. Set `STAFF_PASSWORD` in the host's settings. Then put the app's https address in **Settings › Public link**, so ticket links and QR codes point to it.
- **Your laptop with a free tunnel:** `winget install --id Cloudflare.cloudflared`, start the app, then run `cloudflared tunnel --url http://localhost:3000`. It prints an `https://….trycloudflare.com` link. The laptop has to stay on, and the link changes every time you restart the tunnel.

On the same Wi-Fi, other devices can use the network link shown when the app starts. Booking works that way, but the phone camera won't.

## Settings you can pass

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer |
| `DATA_DIR` | `./data` | Where bookings, receipts, pictures and saved emails live |
| `STAFF_PASSWORD` | generated | Staff password; overrides the saved one |
| `FAKE_NOW` | (unset) | For rehearsals only: pretend it's a given time, like `2026-12-13T09:50` |

## Your data

Everything is in the `data` folder. To back it up, copy that folder.
- `db.json` holds settings, bookings, the standby list and the email log. It also holds the Gmail app password, so keep this folder private.
- `receipts/` holds payment proofs, which only signed-in staff can open.
- `images/` holds the poster and room pictures.
- `outbox/` holds a copy of every email.
