# Planar Bridge

A MTG digital playmat designed for touchscreens and in person play.

This is an early prototype: a shared virtual table for up to 4 Magic: The Gathering players, in the browser on desktop and phone.

## Run it

```
npm install
npm start        # http://localhost:3000
```

Open the page, create a session, and send the invite link (or the 5 letter code) to the other players.
Everyone must be able to reach the same server, so for play over the internet it has to be hosted somewhere.

## What it does

- Built for in-person play with one tablet per player. Your playmat fills the whole screen.
- Each edge of the screen faces another player at the table (left, across, right). Flick a card toward an edge to send it to that player's tablet, where it slides in from your side.
- You can also drag a card onto a player's edge band, or tap or long-press a card for a menu with every move. Tap a band to look at that player's playmat.
- Set who sits where under Menu → Seating. It applies to every tablet.
- Sessions of up to 4 players, joined by link (`/s/CODE`) or code. Reloading the page puts you back in your seat.
- Battlefield, library, graveyard, exile, and a private hand drawer you can tuck away.
- Tap a battlefield card to tap/untap it. Transform double-faced cards, turn cards face down, add counters.
- Library: tap to draw, drag to move the top card, search (only you see it), shuffle, mill.
- Life totals with starting life 20, 30 or 40. The app does not track turns or enforce rules.
- Deck import: paste a text deck list (Moxfield, Archidekt, Arena, MTGO exports). Card data and images come from the Scryfall API.
- Hidden information: hands and libraries are never sent to other players.
- Full screen from the menu. On iPad, use Share → Add to Home Screen for a full-screen app.

## Structure

- `server.js` — Node HTTP + WebSocket server; holds each session's table in memory.
- `public/` — the web client (plain HTML/CSS/JS, no build step).

Sessions live in memory only: restarting the server ends all games.

## License

GPL-3.0, see `LICENSE`.
