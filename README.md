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

- Sessions of up to 4 players, joined by link (`/s/CODE`) or code. Reloading the page puts you back in your seat.
- Built for one tablet per player: your own playmat fills the screen, with your hand along the bottom.
- Opponents show as tiles across the top with their life, card counts and a mini view of their battlefield. Drop a card on a tile to give it to that player, or tap the tile to open their full playmat above yours.
- Each playmat has a battlefield, library, graveyard and exile, plus a private hand.
- Drag any card to any zone on any player's playmat (mouse or touch). Tap or long-press a card for a menu with every move.
- Click/tap a battlefield card to tap/untap it. Transform double-faced cards, turn cards face down, add counters.
- Library: tap to draw, drag to move the top card, search (only you see it), shuffle, mill.
- Life totals with starting life 20, 30 or 40. The app does not track turns or enforce rules.
- Deck import: paste a text deck list (Moxfield, Archidekt, Arena, MTGO exports). Card data and images come from the Scryfall API.
- Hidden information: hands and libraries are never sent to other players.
- Game log of moves, draws and life changes.

## Structure

- `server.js` — Node HTTP + WebSocket server; holds each session's table in memory.
- `public/` — the web client (plain HTML/CSS/JS, no build step).

Sessions live in memory only: restarting the server ends all games.

## License

GPL-3.0, see `LICENSE`.
