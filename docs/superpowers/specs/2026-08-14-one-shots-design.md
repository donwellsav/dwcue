# One Shots Design

## Product intent

Replace the retired fixed-slot model with a compact live surface over the existing playlist. A One Shot is an audio cue with `oneShot` metadata, never a second copy of that cue. It is intended for announcements, stingers, walk-up sounds, and effects that must remain ready and may be fired without changing Up Next.

## Operator model

- The playlist is the single source of truth.
- Marking a cue as a One Shot makes it appear in the One Shots panel.
- Firing a One Shot does not arm or consume Up Next.
- After playback finishes, its tile remains ready.
- Removing a tile clears only its One Shot designation. It never deletes the cue or media.
- Legacy quick-play bindings migrate losslessly: playlist-backed cells flag their cue; cell-only audio moves into a root `One Shots` group in cell order.

## Tile interaction

Regular mode exposes isolated Play/Stop, Settings, and Remove One Shot controls. Show Mode makes the tile body the large trigger, keeps Settings isolated, and never shows Remove. A playing tile exposes Stop. Controls must not bubble into the tile trigger.

The settings control opens an anchored popover with the cue behaviors the current engine already supports:

- playback: Overlay, Duck Program, or Replace Program;
- retrigger: Restart or Ignore while already playing;
- ending: Stop or Loop;
- gain, play fade, stop fade, and ducking values where relevant;
- keyboard shortcut;
- Open Properties for full cue editing.

Unsupported concepts such as simultaneous layering of the same cue UUID or press-and-hold note-off playback are not exposed.

## Data model

`AudioItem.oneShot` is optional. Presence means the cue appears in the panel. It contains only One Shot-specific metadata: stable order, optional keyboard binding, and retrigger behavior. Audio behavior remains in the existing `duckingBehavior`, `endBehavior`, `volume`, `playFade`, and `stopFade` fields so the audio server remains authoritative.

## Safety and accessibility

- Show Mode has no destructive affordance.
- Remove uses an anchored confirmation with explicit `Remove One Shot` wording.
- Empty and disabled states explain how to add a One Shot.
- Tile and controls have distinct accessible names and keyboard behavior.
- Hotkeys do not fire while typing in an input or while a modal/popover is capturing a key.
