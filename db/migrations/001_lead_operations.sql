CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.lead_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id text NOT NULL,
    source text NOT NULL,
    idempotency_key text,
    fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    raw_payload jsonb NOT NULL,
    crm_provider text,
    crm_status text,
    crm_contact_id text,
    crm_error text,
    journal_status text,
    journal_error text,
    telegram_status text,
    telegram_message_id text,
    telegram_error text,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    last_error text,
    response jsonb,
    request_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_operations_idempotency_uidx
    ON app.lead_operations (client_id, source, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_operations_retry_idx
    ON app.lead_operations (status, next_attempt_at)
    WHERE status IN ('retry_scheduled', 'processing');

CREATE INDEX IF NOT EXISTS lead_operations_created_idx
    ON app.lead_operations (created_at);

DROP FUNCTION IF EXISTS app.reserve_lead_operation(text, text, text, text, jsonb, boolean, integer, integer);

CREATE OR REPLACE FUNCTION app.reserve_lead_operation(
    p_client_id text,
    p_source text,
    p_idempotency_key text,
    p_fingerprint text,
    p_raw_payload jsonb,
    p_recovery boolean,
    p_max_attempts integer,
    p_processing_timeout_seconds integer,
    p_operation_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v app.lead_operations;
BEGIN
    IF p_operation_id IS NOT NULL THEN
        SELECT * INTO v
        FROM app.lead_operations
        WHERE id = p_operation_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('outcome', 'not_found');
        END IF;
    ELSIF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
        INSERT INTO app.lead_operations (
            client_id, source, idempotency_key, fingerprint, status, raw_payload, attempts
        ) VALUES (
            p_client_id, p_source, NULL, p_fingerprint, 'processing', p_raw_payload, 1
        ) RETURNING * INTO v;
        RETURN jsonb_build_object('outcome', 'new', 'operation', to_jsonb(v));
    ELSE
        INSERT INTO app.lead_operations (
            client_id, source, idempotency_key, fingerprint, status, raw_payload, attempts
        ) VALUES (
            p_client_id, p_source, p_idempotency_key, p_fingerprint, 'processing', p_raw_payload, 1
        )
        ON CONFLICT (client_id, source, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING * INTO v;

        IF FOUND THEN
            RETURN jsonb_build_object('outcome', 'new', 'operation', to_jsonb(v));
        END IF;

        SELECT * INTO v
        FROM app.lead_operations
        WHERE client_id = p_client_id
          AND source = p_source
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;
    END IF;

    IF v.fingerprint <> p_fingerprint THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'operation', to_jsonb(v));
    END IF;

    IF v.status = 'completed' THEN
        RETURN jsonb_build_object('outcome', 'replay', 'operation', to_jsonb(v));
    END IF;

    IF v.status = 'processing'
       AND v.updated_at > now() - make_interval(secs => p_processing_timeout_seconds) THEN
        RETURN jsonb_build_object('outcome', 'in_progress', 'operation', to_jsonb(v));
    END IF;

    IF v.status NOT IN ('retry_scheduled', 'processing') THEN
        RETURN jsonb_build_object('outcome', 'current', 'operation', to_jsonb(v));
    END IF;

    IF NOT p_recovery THEN
        RETURN jsonb_build_object('outcome', 'in_progress', 'operation', to_jsonb(v));
    END IF;

    IF v.attempts >= p_max_attempts THEN
        UPDATE app.lead_operations
        SET status = 'failed',
            last_error = COALESCE(last_error, 'maximum attempts reached'),
            next_attempt_at = NULL,
            updated_at = now()
        WHERE id = v.id
        RETURNING * INTO v;
        RETURN jsonb_build_object('outcome', 'max_attempts', 'operation', to_jsonb(v));
    END IF;

    UPDATE app.lead_operations
    SET status = 'processing',
        attempts = attempts + 1,
        next_attempt_at = NULL,
        updated_at = now()
    WHERE id = v.id
    RETURNING * INTO v;

    RETURN jsonb_build_object('outcome', 'claimed', 'operation', to_jsonb(v));
END;
$$;

CREATE OR REPLACE FUNCTION app.save_operation_state(
    p_id uuid,
    p_state jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v app.lead_operations;
BEGIN
    UPDATE app.lead_operations
    SET status = CASE WHEN p_state ? 'status' THEN p_state->>'status' ELSE status END,
        crm_provider = CASE WHEN p_state ? 'crm_provider' THEN p_state->>'crm_provider' ELSE crm_provider END,
        crm_status = CASE WHEN p_state ? 'crm_status' THEN p_state->>'crm_status' ELSE crm_status END,
        crm_contact_id = CASE WHEN p_state ? 'crm_contact_id' THEN p_state->>'crm_contact_id' ELSE crm_contact_id END,
        crm_error = CASE WHEN p_state ? 'crm_error' THEN p_state->>'crm_error' ELSE crm_error END,
        journal_status = CASE WHEN p_state ? 'journal_status' THEN p_state->>'journal_status' ELSE journal_status END,
        journal_error = CASE WHEN p_state ? 'journal_error' THEN p_state->>'journal_error' ELSE journal_error END,
        telegram_status = CASE WHEN p_state ? 'telegram_status' THEN p_state->>'telegram_status' ELSE telegram_status END,
        telegram_message_id = CASE WHEN p_state ? 'telegram_message_id' THEN p_state->>'telegram_message_id' ELSE telegram_message_id END,
        telegram_error = CASE WHEN p_state ? 'telegram_error' THEN p_state->>'telegram_error' ELSE telegram_error END,
        attempts = COALESCE((p_state->>'attempts')::integer, attempts),
        next_attempt_at = CASE WHEN p_state ? 'next_attempt_at' THEN (p_state->>'next_attempt_at')::timestamptz ELSE next_attempt_at END,
        last_error = CASE WHEN p_state ? 'last_error' THEN p_state->>'last_error' ELSE last_error END,
        response = CASE WHEN p_state ? 'response' THEN p_state->'response' ELSE response END,
        request_id = COALESCE(p_state->>'request_id', request_id),
        updated_at = now(),
        completed_at = CASE
            WHEN p_state->>'status' = 'completed' THEN COALESCE(completed_at, now())
            ELSE completed_at
        END
    WHERE id = p_id
    RETURNING * INTO v;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'operation % not found', p_id;
    END IF;

    RETURN jsonb_build_object('operation', to_jsonb(v));
END;
$$;

CREATE OR REPLACE FUNCTION app.cleanup_lead_operations(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted integer;
BEGIN
    DELETE FROM app.lead_operations
    WHERE status IN ('completed', 'failed')
      AND updated_at < now() - make_interval(days => p_retention_days);
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;
