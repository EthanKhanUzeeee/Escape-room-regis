# Escape Room Booking

Booking and check-in software for a one-day escape room event.

| Folder | What it is |
| --- | --- |
| [`escape-room-booking/`](escape-room-booking/) | **The main app.** Three themed rooms, 45-minute slots from 9:00 AM to 7:45 PM, team or solo matchmaking, payment receipt uploads, QR tickets by email, a staff dashboard, a phone scanner for the door, a standby list for walk-ins, a game timer for each room's game master, a TV leaderboard (top 6 per room), and Google Sheet sync. |
| [`escape-room-registration/`](escape-room-registration/) | The first, simpler version: one time-slot list, group registration with a receipt upload, and approvals. Kept for reference. |

## Run the main app

You need [Node.js](https://nodejs.org) 18 or newer.

```
cd escape-room-booking
npm install
node server.js
```

On Windows, double-click `escape-room-booking/start-online.bat` to run it with a public https link (free, through Tailscale), or `start.bat` to run it only on this computer.

Then open:
- http://localhost:3000 for the booking page.
- http://localhost:3000/staff for the staff dashboard. The first password is written to `escape-room-booking/data/STAFF-PASSWORD.txt`.

Setup, email, the Google Sheet, and putting the app online are covered in [`escape-room-booking/README.md`](escape-room-booking/README.md).

For real use, keep the data in the event's Google Drive. Then any laptop, or Render's free plan (`render.yaml` is included), runs the app with the same bookings. See [`escape-room-booking/README.md`](escape-room-booking/README.md).

## What isn't in this repository

The `data/` folders and `config.env` are ignored on purpose. They hold bookings, payment receipts, the staff password and the Google connector's secret key, so they never go to GitHub.
