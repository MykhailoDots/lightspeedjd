We would like to make some changes in the TagiNet Importer that the organization called "small Foot" UpsertMetrics

Right now, we use a static modifier for children under 18 years, we want to have a more complex modifier.

- Children under 18 month are weighted 1.5
- Children after 18 months until 36 months are weighted 1
- Children after 36 months are weighted 0.8
- Children which turn 5 years old after the 30th of June in the respective year are weighted 0.5

We can hardcode this in the taginet importer.

Further, we should add a new config in that allows to specify an array of cost centers / mandanten which have no weights at all and we just take the value from TagiNet.

We can create unit tests for this function.

This prompt is saved here:
prompts/2025-06-04-small-foot-calculation-prompt.md

Create an implementation plan in the state first. Please keep all the state, used commands, progress here:
prompts/2025-06-04-small-foot-calculation-state.md

It can be that at any time you lose the history and you need to retrieve the progress from the state.

Do not commit anything! And do not run the app!
