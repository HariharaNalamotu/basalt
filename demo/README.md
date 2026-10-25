# Security demo: attack the app from inside its own page

`attack.js` tries to break a live Basalt app from the browser console, the way a hacker or broken AI-written code would. It uses customer B's real login and the same door the app's own code uses (`/_basalt/data`), then shows a full-screen panel of what was refused.

It tries nine things: listing every booking, opening, changing and cancelling customer A's booking by its id, deleting or running raw database code, booking in A's name, a search that sneaks in database code, reading the database's password table and a forged login for A. It also checks that B can still open B's own booking, so a refusal means something.

## Run it

You need two browser profiles (or one normal window and one guest window), each signed in as a different customer on the production app, and each with at least one booking.

1. **As customer A:** open DevTools (Cmd+Option+J), paste all of `attack.js`, press Enter, then run `basaltAttack()`. It prints and copies a command like `basaltAttack('<id>', '<owner>', 'bookings')`.
2. **As customer B:** paste all of `attack.js`, then paste that command.

The first paste in a profile, Chrome asks you to type `allow pasting`. Do that before going on stage.

For a table other than `bookings`, pass its name: `basaltAttack(undefined, undefined, 'orders')` for step 1.

## The stage app: Pulse

[`pulse-app/`](pulse-app/) is Pulse, the gym class booking app Claude built on Basalt from one sentence and the one we demo on. Every Basalt install has its own database, so to demo on another laptop you deploy it there and make the demo accounts again:

1. Start Basalt on that laptop (`./start.sh`) and connect Claude Code to it from the Connect page.
2. Ask Claude Code to deploy `demo/pulse-app` as an app named `pulsegym` all the way to production. The data rules are in its `basalt.data.json`, so it stops once for the owner's approval link.
3. Ask Claude Code to make the customer accounts on the live site, with `host_test_emails` for the sign up codes, and to book a class for each customer.
4. Serve this folder so the stage browser can load the script: `python3 -m http.server 8799 --bind 127.0.0.1` from `demo/`, then the script is at `http://127.0.0.1:8799/attack.js`.
5. Run it as in "Run it" above. Customer A's `basaltAttack()` gives the ids for customer B's command, so nothing needs copying from another laptop.

## How we know it isn't always green

`node demo/check.mjs` runs it against fake backends: one that behaves like Basalt, one that hands everything to everyone, one with the false greens Codex found in review (another customer's rows in a search, a validation error, an outage) and one that leaks on page two. Every leak shows as LEAKED and anything that isn't a clear "no" shows as CAN'T TELL. (The forged-login check shows CAN'T TELL on the Basalt-like fake only because the fake doesn't check logins.)

Against the local platform's production salon app (2026-10-24), all nine attacks are refused and B's own booking still opens. The script saves one throwaway test entry as B, far in the future, to learn who B is, and archives it at the end. If an attack ever does get through on A's booking, the script puts the booking back.

Only run it on demo customers' accounts.
