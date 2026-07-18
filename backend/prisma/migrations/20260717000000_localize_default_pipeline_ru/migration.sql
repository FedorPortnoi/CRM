-- Localize stages before their parent pipeline so the English parent name
-- remains available for the scoped stage lookup.
UPDATE "PipelineStage" AS stage
SET
  "name" = seed.localized_name,
  "updated_at" = NOW()
FROM
  "Pipeline" AS pipeline,
  (
    VALUES
      ('Lead',       0, false, false, 'Новый лид'),
      ('Qualified',  1, false, false, 'Квалификация'),
      ('Proposal',   2, false, false, 'Предложение'),
      ('Closed Won', 3, true,  false, 'Сделка выиграна')
  ) AS seed(
    original_name,
    original_position,
    original_is_won,
    original_is_lost,
    localized_name
  )
WHERE stage."pipeline_id" = pipeline."id"
  AND pipeline."name" = 'Sales Pipeline'
  AND pipeline."is_default" = true
  AND stage."name" = seed.original_name
  AND stage."position" = seed.original_position
  AND stage."is_won_stage" = seed.original_is_won
  AND stage."is_lost_stage" = seed.original_is_lost;

UPDATE "Pipeline"
SET
  "name" = 'Воронка продаж',
  "updated_at" = NOW()
WHERE "name" = 'Sales Pipeline'
  AND "is_default" = true;
