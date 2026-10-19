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
  // 128bitfantasy (live, signed in): results and lineup fixes, one-line title from the app.
  'matchup.won': FantasyResult;
  'matchup.lost': FantasyResult;
  'matchup.tied': FantasyResult;
  'lineup.fixed': FantasyResult;
  // 128bitmusic (live, signed in)
  /** One per day, id `music-listening-YYYY-MM-DD`, replaced as the day goes on. */
  'listening.day': { date: string; minutes: number; songs: number; topArtist: string | null };
  'level.up': { level: number; app?: string };
  'badge.earned': { title: string; description?: string };
  // 128bitmusic and 128bittrip
  'quest.completed': { title?: string; questId?: string; xp?: number };
  // 128bittrip (live, signed in; XP from its table rides along)
  'booking.made': { via?: string; destination?: string; xp?: number };
  'trip.created': { xp?: number; destination?: string };
  'trip.packing.done': { xp?: number };
  'trip.checkin': { xp?: number; city?: string };
  'esim.purchased': { xp?: number };
  // 128bitmap (live, signed in): a trip finished with guidance
  'route.finished': { mode: string; km: number; minutes: number; to: string | null };
  // Planned
  'budget.updated': { name: string };
  'track.played': { title: string; artist?: string };
};

type FantasyResult = { title: string; league: string; sport: string; week: number | null; detail: string };

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
