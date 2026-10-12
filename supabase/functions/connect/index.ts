// Supabase Edge Function entry. Deploy with verify_jwt off: /callback is opened by the
// person's browser, and every other route checks the 128bit sign-in itself.
import { createHandler } from './handler.ts';

Deno.serve(createHandler({ env: (k) => Deno.env.get(k), fetch }));
