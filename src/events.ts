/**
 * The 128bit family event schema (v1). Every 128bit app posts events like these to the
 * user's family feed; Tracker reads the feed and renders one timeline. See docs/EVENTS.md.
 *
 * The feed is the `family_events` table in the user's Supabase project, reached only
 * through two RPCs: log_events(events jsonb) and get_events(before_ms bigint, max_rows int).
 */

export type FamilyApp = 'play' | 'tracker' | 'fit' | 'gold' | 'music' | 'fantasy' | 'trip' | 'life';

/** Event data per type. Small, display-ready fields only. */
export type FamilyEventData = {
  // 128bitPlay (live)
  'book.finished': { title: string; author?: string };
  'movie.watched': { title: string };
  'episode.watched': { show: string; episode?: string };
  'chapter.read': { comic: string };
  // 128bit Tracker (planned)
  'habit.completed': { tracker: string; value?: number; unit?: string };
  'streak.milestone': { tracker: string; days: number };
  'streak.frozen': { tracker: string };
  // Siblings (planned, names from the family brief)
  'workout.logged': { name: string; minutes?: number };
  'budget.updated': { name: string };
  'track.played': { title: string; artist?: string };
  'matchup.won': { league: string; score?: string };
  'booking.made': { place: string };
};

export type FamilyEventType = keyof FamilyEventData;

export type FamilyEvent<T extends FamilyEventType = FamilyEventType> = {
  /** Unique per event per account; sending the same id twice does nothing. */
  id: string;
  app: FamilyApp;
  type: T;
  /** When it happened, ms since 1970. */
  at: number;
  data: FamilyEventData[T];
};
