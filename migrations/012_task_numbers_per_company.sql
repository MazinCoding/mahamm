-- Task numbers per company: each company's tasks are numbered from #1.
--
-- A task's id is its number, unique within its company. Row-level security
-- already limits every query to one company, so /tasks/12 means the current
-- company's #12 everywhere without changing how the code looks tasks up.
-- Existing tasks keep their numbers.

-- The next number for each company.
CREATE TABLE task_counters (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  next_id integer NOT NULL CHECK (next_id > 0)
);
ALTER TABLE task_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON task_counters
  USING (mahamm_bypass() OR org_id = mahamm_org()) WITH CHECK (mahamm_bypass() OR org_id = mahamm_org());

INSERT INTO task_counters (org_id, next_id)
SELECT org_id, max(id) + 1 FROM tasks GROUP BY org_id;

-- A new task gets its company's next number. Taking the counter's row lock
-- means two tasks added at the same moment never get the same number.
CREATE FUNCTION tasks_next_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN
    INSERT INTO task_counters AS c (org_id, next_id) VALUES (NEW.org_id, 2)
    ON CONFLICT (org_id) DO UPDATE SET next_id = c.next_id + 1
    RETURNING c.next_id - 1 INTO NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE tasks ALTER COLUMN id DROP DEFAULT;
CREATE TRIGGER tasks_number BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION tasks_next_number();

-- Ids are now unique per company only. The links from step 1 already point at
-- (org_id, id); the old single-column links and the global key go.
ALTER TABLE tasks DROP CONSTRAINT tasks_pkey CASCADE;
