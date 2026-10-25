# Security demo: attack the app from inside its own page

`attack.js` tries to break a live Basalt app from the browser console, the way a hacker or broken AI-written code would. It uses customer B's real login and the same door the app's own code uses (`/_basalt/data`), then shows a full-screen panel of what was refused.

It tries nine things: listing every booking, opening, changing and cancelling customer A's booking by its id, deleting or running raw database code, booking in A's name, a search that sneaks in database code, reading the database's password table and a forged login for A. It also checks that B can still open B's own booking, so a refusal means something.

## Run it

You need two browser profiles (or one normal window and one guest window), each signed in as a different customer on the production app, and each with at least one booking.

1. **As customer A:** open DevTools (Cmd+Option+J), paste all of `attack.js`, press Enter, then run `basaltAttack()`. It prints and copies a command like `basaltAttack('<id>', '<owner>', 'bookings')`.
2. **As customer B:** paste all of `attack.js`, then paste that command.

The first paste in a profile, Chrome asks you to type `allow pasting`. Do that before going on stage.

For a table other than `bookings`, pass its name: `basaltAttack(undefined, undefined, 'orders')` for step 1.

## How we know it isn't always green

`node demo/check.mjs` runs it against fake backends: one that behaves like Basalt, one that hands everything to everyone, one with the false greens Codex found in review (another customer's rows in a search, a validation error, an outage) and one that leaks on page two. Every leak shows as LEAKED and anything that isn't a clear "no" shows as CAN'T TELL. (The forged-login check shows CAN'T TELL on the Basalt-like fake only because the fake doesn't check logins.)

Against the local platform's production salon app (2026-10-24), all nine attacks are refused and B's own booking still opens. The script saves one throwaway test entry as B, far in the future, to learn who B is, and archives it at the end. If an attack ever does get through on A's booking, the script puts the booking back.

Only run it on demo customers' accounts.
