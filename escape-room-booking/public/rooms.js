'use strict';
/*
 * The story and look of each room on the booking page and the ticket.
 * Room names and difficulty come from the app (Settings › Rooms); this file only adds the mood,
 * matched by room id (r1, r2, r3). A teaser typed in Settings replaces the story text here.
 * Keep it spoiler-free: never put puzzle answers, codes or the twist ending in this file.
 */

const ROOM_STORIES = {
  r1: {
    tone: 'house',
    genre: 'Psychological horror · Mystery',
    hook: 'Nobody on the street talks about Lola Esperanza’s house anymore. Tonight your group got an invitation with no sender, just the address and one line: “May naiwan kayo sa bahay na ito.” Inside, every family photo has its faces scratched out. Every one except hers.',
    line: '“Matagal ko na kayong hinihintay.”',
    notes: ['No jump scares', 'Tagalog voice recordings'],
  },
  r2: {
    tone: 'museum',
    genre: 'Supernatural thriller',
    hook: 'It’s your first night shift as a museum security guard. At exactly 12:00 AM the main lights die, red emergency lamps flicker on and every exit seals itself. Something in the Antiquities Wing has woken up.',
    line: 'Hold out until sunrise.',
    notes: ['Darkness and fog', 'Flashing red lights', 'Loud sounds'],
  },
  r3: {
    tone: 'lab',
    genre: 'Bio-horror survival',
    hook: 'You wake up in a basement lab with a hospital wristband on your arm and no memory of how you got there. The walls are wrapped in stained plastic, one lamp flickers overhead, and something in the corner cage has started to growl.',
    line: 'Warning: bio-containment compromised.',
    notes: ['Live actor', 'Fake blood', 'Loud alarms'],
  },
};

const ROOM_TONES = ['house', 'museum', 'lab'];
const LEVEL_NAMES = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };

/** A room's story, falling back to a look by position for rooms this file doesn't know. */
function roomStory(room, index = 0) {
  const s = ROOM_STORIES[room.id] || {};
  return {
    tone: s.tone || ROOM_TONES[index % ROOM_TONES.length],
    genre: s.genre || '',
    hook: room.teaser || s.hook || 'Story coming soon.',
    line: s.line || '',
    notes: s.notes || [],
  };
}

const levelName = (n) => LEVEL_NAMES[n] || `Level ${n}`;

/*
 * Moving parts laid over each drawing. They are separate light layers that only fade in and out,
 * so phones don't redraw the heavy drawing every frame:
 * the house flickers Lola's face onto the veiled figure, the museum's glyphs breathe under a pulsing alarm,
 * and the lab's ceiling light stutters while the room dims with it.
 */
const ART_FX = {
  house: () => [h('img', { class: 'art-fx fx-face', src: '/static/art/house-face.svg', alt: '' })],
  museum: () => [h('span', { class: 'art-fx fx-alarm' }), h('img', { class: 'art-fx fx-glyphs', src: '/static/art/museum-glow.svg', alt: '' })],
  lab: () => [h('span', { class: 'art-fx fx-lamp' }), h('span', { class: 'art-fx fx-dim' })],
};

/** The room's photo from Settings, or its drawn and animated artwork until one is uploaded. */
function roomArt(room, tone) {
  if (room.image) return h('div', { class: 'art-stage' }, h('img', { class: 'room-img', src: room.image, alt: room.name, loading: 'lazy' }));
  return h('div', { class: 'art-stage', 'aria-hidden': 'true' },
    h('img', { class: 'room-img', src: `/static/art/${tone}.svg`, alt: '', loading: 'lazy' }),
    ART_FX[tone] && !document.documentElement.classList.contains('lite') ? ART_FX[tone]() : null); // the lite version skips the moving layers
}
