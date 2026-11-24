# Escape Room Registration

A Luma-style event page where groups pick a time slot, fill in their details, upload a payment receipt and wait for approval, plus an organizer dashboard for approving them.

**Groups can**
- pick a time slot (9:00–10:00, 10:00–11:00 …). Full slots are crossed out, and a slot is held as soon as a group registers.
- enter a group name, leader name, email, mobile number, school and every player's name
- see the amount to pay and your payment instructions, then upload a receipt screenshot or PDF with its reference number
- get a registration code (like `ESC-7K3QM`) and check later whether they were approved

**Organizers can**
- see who's waiting for review, open each receipt and approve or reject it
- move a group to another slot and leave them a note they see when they check their status
- copy a ready-made confirmation message to send by Messenger or SMS
- add time slots for one or more days, change how many groups fit in each slot
- edit the event name, venue, price (per group or per player), player limits and payment details
- download everything as a CSV for Excel or Google Sheets

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else needs installing.

- **Windows:** double-click `start.bat`. It starts the app and opens the organizer dashboard.
- **Any system:** open a terminal in this folder and run `node server.js`, then go to http://localhost:3000.

Keep the window open while people register. Press Ctrl+C to stop.

### First time

1. The first run makes an organizer password and saves it in `data/ADMIN-PASSWORD.txt`.
2. Go to http://localhost:3000/admin and sign in with it.
3. Open **Event settings**: set the event name, venue, price, and your GCash or bank details. Then set your own password (the text file is deleted when you do).
4. Open **Time slots**: remove the example day and add your real date(s). Leave the slot length at 1 hour for 9–10, 10–11 and so on.
5. Share the registration link.

## Sharing the link

| Who needs to register | What to do |
| --- | --- |
| Only you, testing | Use http://localhost:3000 |
| People on the same Wi-Fi | Use the **Same Wi-Fi** link on the dashboard (like `http://192.168.1.5:3000`). When Windows asks whether Node.js may use the network, allow it on private networks. |
| Anyone, anywhere | Put it online (below) |

### Put it online

**Quick, free, from your own computer:** install Cloudflare's tunnel tool once (`winget install --id Cloudflare.cloudflared`), start the app, then run:

```
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://….trycloudflare.com` link to share. Your computer has to stay on with the app running, and you get a new link each time you start the tunnel.

**Always on:** deploy the folder to a Node host (Render, Railway, Fly.io or a small VPS) with the start command `node server.js`. Attach a persistent disk and set `DATA_DIR` to it, or registrations disappear whenever the host restarts. Set `ADMIN_PASSWORD` in the host's environment settings.

## Settings you can pass

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer |
| `DATA_DIR` | `./data` | Where registrations and receipts are saved |
| `ADMIN_PASSWORD` | generated | Organizer password; overrides the saved one |

## Your data

Everything lives in the `data` folder:

- `db.json`: settings, time slots and registrations
- `receipts/`: uploaded payment proofs, only visible to signed-in organizers

To back up, copy the `data` folder. To start over, stop the app and delete the `data` folder.

## Good to know

- Slots count pending and approved groups, so two groups can't pay for the last spot. Rejecting a group frees its spot.
- Group names must be unique, so you can tell teams apart on the day.
- The app doesn't send emails. Groups check their status with their code and email, and you can copy a message from the dashboard to send them.
