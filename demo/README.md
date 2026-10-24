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

Against a fake backend that hands everything to everyone, all nine attacks show as LEAKED (checked 2026-10-24). Against the local platform's production salon app, all nine are refused and B's own booking still opens.
