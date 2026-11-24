# Escape Room Booking

Booking and check-in software for a one-day escape room event.

| Folder | What it is |
| --- | --- |
| [`escape-room-booking/`](escape-room-booking/) | **The main app.** Three themed rooms, 45-minute slots from 9:00 AM to 7:45 PM, team or solo matchmaking, payment receipt uploads, QR tickets by email, a staff dashboard, a phone scanner for the door, a standby list for walk-ins, and Google Sheet sync. |
| [`escape-room-registration/`](escape-room-registration/) | The first, simpler version: one time-slot list, group registration with a receipt upload, and approvals. Kept for reference. |

## Run the main app

You need [Node.js](https://nodejs.org) 18 or newer.

```
cd escape-room-booking
npm install
node server.js
```

On Windows you can double-click `escape-room-booking/start.bat` instead.

Then open:
- http://localhost:3000 for the booking page.
- http://localhost:3000/staff for the staff dashboard. The first password is written to `escape-room-booking/data/STAFF-PASSWORD.txt`.

Setup, email, the Google Sheet, and putting the app online are covered in [`escape-room-booking/README.md`](escape-room-booking/README.md).

## What isn't in this repository

The `data/` folders are ignored on purpose. They hold bookings, payment receipts, the staff password and the Gmail app password, so they stay on the computer or server running the app. Back them up separately.
