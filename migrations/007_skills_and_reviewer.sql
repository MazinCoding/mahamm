-- Skills: what each person is good at, in their own words, used to suggest
-- tasks that fit them. Reviewer: who checks a task in Review; with nobody set,
-- the task's creator is told, as before.

ALTER TABLE users ADD COLUMN skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 20);
ALTER TABLE tasks ADD COLUMN reviewer_id uuid REFERENCES users(id);
CREATE INDEX tasks_reviewer_idx ON tasks (reviewer_id) WHERE closed_at IS NULL AND reviewer_id IS NOT NULL;
