// Deck handling for rooms that opt into the app dealing cards.
// A card is a two-character string: rank then suit, e.g. 'Ah', 'Td', '2c'.

import { randomInt } from 'node:crypto';

const RANKS = '23456789TJQKA';
const SUITS = 'shdc'; // spades, hearts, diamonds, clubs

// Two per player, plus a burn and the five board cards.
export const CARDS_PER_PLAYER = 2;
export const BOARD_OVERHEAD = 8; // 3 burns + 5 community

export function buildDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) deck.push(rank + suit);
  }
  return deck;
}

// Fisher-Yates driven by the crypto RNG rather than Math.random — people bet
// real money on this, and Math.random is neither uniform nor unpredictable.
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// How many players a full deck can seat with the board dealt out.
export function maxSeatsForDeck() {
  return Math.floor((buildDeck().length - BOARD_OVERHEAD) / CARDS_PER_PLAYER);
}
