// Imported first by tests that need an attachment root: PLANNER_ROOT is read
// once, when attachments.ts loads, so it has to be set before anything imports it.
process.env['PLANNER_ROOT'] = '/Planner';
