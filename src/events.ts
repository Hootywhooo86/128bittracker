/**
 * The 128bit family event schema (v1). Every 128bit app posts events like these to the
 * user's family feed; Tracker reads the feed and renders one timeline. See docs/EVENTS.md.
 *
 * The feed is the `family_events` table in the user's Supabase project (supabase/family.sql),
 * reached only through RPCs: log_events, get_events, delete_event, and log_events_with_key
 * for outside apps. Trakt and Hardcover aren't in the feed: the timeline reads them directly.
 */

export type FamilyApp =
  | 'play' | 'tracker' | 'fit' | 'gold' | 'music' | 'fantasy' | 'trip' | 'life'
  /** Posted with a personal key from outside apps (Zapier, Tasker, Shortcuts…). Any name works. */
  | 'custom' | (string & {});

/** Event data per type. Small, display-ready fields only. */
export type FamilyEventData = {
  // 128bitPlay (live)
  'book.finished': { title: string; author?: string };
  'movie.watched': { title: string };
  'episode.watched': { show: string; episode?: string };
  'chapter.read': { comic: string };
  // 128bitfit (live; opt-in per kind in its Settings → 128bit family)
  'workout.logged':
    | { kind: 'strength'; name: string; minutes: number; exercises: number; sets: number }
    | { kind: 'cardio'; name: string; minutes: number; km: number | null };
  /** One per day, id `fit-health-YYYY-MM-DD`, replaced as the day goes on. null = not measured. */
  'health.day': {
    date: string;
    steps: number | null;
    sleepMinutes: number | null;
    restingHeartRate: number | null;
    activeCalories: number | null;
    km: number | null;
  };
  // 128bit Tracker (live: the timeline's Log anything)
  'habit.completed': { tracker: string; value?: number; unit?: string };
  'streak.milestone': { tracker: string; days: number };
  'streak.frozen': { tracker: string };
  // Siblings (planned, names from the family brief)
  'budget.updated': { name: string };
  'track.played': { title: string; artist?: string };
  'matchup.won': { league: string; score?: string };
  'booking.made': { place: string };
};

export type FamilyEventType = keyof FamilyEventData;

export type FamilyEvent<T extends FamilyEventType = FamilyEventType> = {
  /** Unique per event per account; sending the same id again replaces the event. */
  id: string;
  app: FamilyApp;
  type: T;
  /** When it happened, ms since 1970. */
  at: number;
  data: FamilyEventData[T];
};
