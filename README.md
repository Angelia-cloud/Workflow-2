Client/Intent/Prompt Pipeline
What it does

A script that automates the first part of our GEO process

You give it two things:

1.A written description of a client (or hotel)
2.Raw notes or transcripts about what customers ask

It then does three things automatically:

1.Reads the client description and pulls out the important stuff - who they're targeting, what makes them stand out, what their goals are.
2.Reads the customer notes and figures out what questions people are actually asking (like "family-friendly hotels near Coogee").
3.Turns those questions into example prompts someone might type into ChatGPT or Gemini, so we can track how well the client shows up in AI search results.

All of it gets saved straight into our Supabase database, ready for the next step (measurement).

Status

Working end to end, tested against the real IC Coogee client record in Supabase. Run so far on test content, not real Coogee data yet.

Using Truc's Groq key for now until proper API access is sorted.
