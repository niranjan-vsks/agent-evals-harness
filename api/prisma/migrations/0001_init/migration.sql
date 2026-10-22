-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "task_category" AS ENUM ('memory_dependent', 'memory_distractor', 'neutral_deterministic', 'neutral_judged', 'honesty');

-- CreateEnum
CREATE TYPE "experiment_status" AS ENUM ('draft', 'queued', 'running', 'completed', 'partial', 'cancelled');

-- CreateEnum
CREATE TYPE "experiment_phase" AS ENUM ('pilot', 'full');

-- CreateEnum
CREATE TYPE "trial_status" AS ENUM ('pending', 'running', 'done', 'errored', 'cancelled');

-- CreateEnum
CREATE TYPE "exit_reason" AS ENUM ('completed', 'max_steps', 'timeout', 'invalid_tool_call', 'agent_error');

-- CreateEnum
CREATE TYPE "error_class" AS ENUM ('rate_limited', 'provider_error', 'worker_crash', 'grader_error', 'config_invalid', 'backpressure', 'orphaned', 'cancelled');

-- CreateEnum
CREATE TYPE "attempt_result" AS ENUM ('done', 'errored', 'orphaned', 'cancelled');

-- CreateEnum
CREATE TYPE "grader_type" AS ENUM ('exact_match', 'file_state', 'unit_test', 'trace_check', 'llm_judge');

-- CreateEnum
CREATE TYPE "judge_policy" AS ENUM ('trusted', 'flagged', 'excluded');

-- CreateTable
CREATE TABLE "model" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key_env" TEXT NOT NULL,
    "input_price_per_mtok" DECIMAL(12,6) NOT NULL,
    "output_price_per_mtok" DECIMAL(12,6) NOT NULL,
    "context_window" INTEGER NOT NULL,
    "roles" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harness" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harness_pkey" PRIMARY KEY ("id","version")
);

-- CreateTable
CREATE TABLE "memory_fixture" (
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_fixture_pkey" PRIMARY KEY ("name","hash")
);

-- CreateTable
CREATE TABLE "task" (
    "id" TEXT NOT NULL,
    "version_hash" TEXT NOT NULL,
    "category" "task_category" NOT NULL,
    "prompt" TEXT NOT NULL,
    "fixture_dir" TEXT,
    "memory_fixture" TEXT,
    "graders" JSONB NOT NULL,
    "discriminates" TEXT[],
    "tags" TEXT[],
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id","version_hash")
);

-- CreateTable
CREATE TABLE "config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "harness_id" TEXT NOT NULL,
    "harness_version" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "experiment_status" NOT NULL DEFAULT 'draft',
    "n_trials" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "phase" "experiment_phase" NOT NULL,
    "axis" TEXT,
    "hypothesis" TEXT,
    "worker_manifest" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "pause_reason" TEXT,

    CONSTRAINT "experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_config" (
    "experiment_id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "experiment_config_pkey" PRIMARY KEY ("experiment_id","config_id")
);

-- CreateTable
CREATE TABLE "experiment_task" (
    "experiment_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_version_hash" TEXT NOT NULL,

    CONSTRAINT "experiment_task_pkey" PRIMARY KEY ("experiment_id","task_id")
);

-- CreateTable
CREATE TABLE "trial" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_version_hash" TEXT NOT NULL,
    "trial_index" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "status" "trial_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN,
    "exit_reason" "exit_reason",
    "steps" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "api_calls" INTEGER,
    "latency_ms" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "harness_cost_usd" DECIMAL(12,6),
    "price_snapshot" JSONB NOT NULL,
    "rate_limit_events" INTEGER NOT NULL DEFAULT 0,
    "error_class" "error_class",
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "trial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_attempt" (
    "id" TEXT NOT NULL,
    "trial_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "result" "attempt_result",
    "error_class" "error_class",
    "error_message" TEXT,
    "partial_trace" JSONB,

    CONSTRAINT "trial_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trace" (
    "trial_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "harness_id" TEXT NOT NULL,
    "harness_version" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "system_prompt" TEXT,
    "events" JSONB NOT NULL,
    "memory_initial" JSONB NOT NULL,
    "memory_final" JSONB NOT NULL,
    "skills_invoked" TEXT[],
    "notes" TEXT[],
    "final_response" TEXT,

    CONSTRAINT "trace_pkey" PRIMARY KEY ("trial_id")
);

-- CreateTable
CREATE TABLE "grader_result" (
    "id" TEXT NOT NULL,
    "trial_id" TEXT NOT NULL,
    "grader_index" INTEGER NOT NULL,
    "grader_type" "grader_type" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "details" JSONB NOT NULL,
    "reasoning" TEXT,
    "judge_model_id" TEXT,
    "judge_prompt_hash" TEXT,
    "duration_ms" INTEGER NOT NULL,

    CONSTRAINT "grader_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judge_label" (
    "id" TEXT NOT NULL,
    "trial_id" TEXT NOT NULL,
    "grader_index" INTEGER NOT NULL,
    "human_passed" BOOLEAN NOT NULL,
    "labeler" TEXT NOT NULL,
    "labeled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "judge_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judge_validation" (
    "id" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "judge_model_id" TEXT NOT NULL,
    "judge_prompt_hash" TEXT NOT NULL,
    "label_set_hash" TEXT NOT NULL,
    "n_items" INTEGER NOT NULL,
    "agreement_raw" DECIMAL(6,4) NOT NULL,
    "kappa" DECIMAL(6,4) NOT NULL,
    "kappa_ci_low" DECIMAL(6,4) NOT NULL,
    "kappa_ci_high" DECIMAL(6,4) NOT NULL,
    "policy" "judge_policy" NOT NULL,

    CONSTRAINT "judge_validation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_run" (
    "id" TEXT NOT NULL,
    "experiment_id" TEXT NOT NULL,
    "config_a_id" TEXT NOT NULL,
    "config_b_id" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stats_version" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "resamples" INTEGER NOT NULL,
    "judge_policy_applied" "judge_policy" NOT NULL,
    "result" JSONB NOT NULL,

    CONSTRAINT "comparison_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_slug_key" ON "model"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "config_config_hash_key" ON "config"("config_hash");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_config_experiment_id_position_key" ON "experiment_config"("experiment_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "trial_experiment_id_config_id_task_id_trial_index_key" ON "trial"("experiment_id", "config_id", "task_id", "trial_index");

-- CreateIndex
CREATE UNIQUE INDEX "trial_attempt_trial_id_attempt_no_key" ON "trial_attempt"("trial_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "grader_result_trial_id_grader_index_key" ON "grader_result"("trial_id", "grader_index");

-- CreateIndex
CREATE UNIQUE INDEX "judge_label_trial_id_grader_index_labeler_key" ON "judge_label"("trial_id", "grader_index", "labeler");

-- AddForeignKey
ALTER TABLE "config" ADD CONSTRAINT "config_harness_id_harness_version_fkey" FOREIGN KEY ("harness_id", "harness_version") REFERENCES "harness"("id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config" ADD CONSTRAINT "config_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_config" ADD CONSTRAINT "experiment_config_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_config" ADD CONSTRAINT "experiment_config_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_task" ADD CONSTRAINT "experiment_task_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_task" ADD CONSTRAINT "experiment_task_task_id_task_version_hash_fkey" FOREIGN KEY ("task_id", "task_version_hash") REFERENCES "task"("id", "version_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial" ADD CONSTRAINT "trial_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial" ADD CONSTRAINT "trial_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial" ADD CONSTRAINT "trial_task_id_task_version_hash_fkey" FOREIGN KEY ("task_id", "task_version_hash") REFERENCES "task"("id", "version_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_attempt" ADD CONSTRAINT "trial_attempt_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "trial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace" ADD CONSTRAINT "trace_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "trial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grader_result" ADD CONSTRAINT "grader_result_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "trial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_label" ADD CONSTRAINT "judge_label_trial_id_grader_index_fkey" FOREIGN KEY ("trial_id", "grader_index") REFERENCES "grader_result"("trial_id", "grader_index") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_run" ADD CONSTRAINT "comparison_run_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_run" ADD CONSTRAINT "comparison_run_config_a_id_fkey" FOREIGN KEY ("config_a_id") REFERENCES "config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_run" ADD CONSTRAINT "comparison_run_config_b_id_fkey" FOREIGN KEY ("config_b_id") REFERENCES "config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

