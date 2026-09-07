#!/bin/bash
# DSP → ResellerOS migration · STEP 1: EXTRACT (read-only).
# Run ON THE DSP VM (where MySQL lives). Produces line-per-row JSON in ./out/
# plus counts.txt — the numbers §5 of docs/DSP-DATA-MIGRATION.md verifies against.
# Nothing here writes to the database.
set -euo pipefail
DB="${DSP_DB:-dsp}"
MY="mysql -N -B $DB -e"
mkdir -p out

$MY "select json_object('id',t.id,'customer_id',t.customer_id,'subject',t.subject,
  'description',t.description,'status',t.status,'priority',t.priority,
  'created_at',t.created_at,'updated_at',t.updated_at,'cc_emails',t.cc_emails,
  'sla_response_due',t.sla_response_due,'first_response_at',t.first_response_at,
  'due_date',t.due_date,'merged_into',t.merged_into,'request_type',t.request_type,
  'gw_edition',t.gw_edition,'affected_users',t.affected_users,
  'pending_reason',t.pending_reason,'google_case_id',t.google_case_id)
  from tickets t" > out/tickets.jsonl

$MY "select json_object('id',m.id,'ticket_id',m.ticket_id,'message',m.message,
  'via_email',m.via_email,'created_at',m.created_at,
  'sender_role',u.role,'sender_name',u.name,'sender_email',u.email)
  from ticket_messages m join users u on u.id=m.sender_id" > out/messages.jsonl

$MY "select json_object('id',n.id,'ticket_id',n.ticket_id,'note',n.note,
  'created_at',n.created_at,'agent_name',u.name)
  from ticket_internal_notes n join users u on u.id=n.agent_id" > out/notes.jsonl

$MY "select json_object('id',l.id,'ticket_id',l.ticket_id,'seconds',l.seconds,
  'logged_at',l.logged_at,'agent_name',u.name)
  from ticket_time_logs l join users u on u.id=l.agent_id" > out/timelogs.jsonl

$MY "select json_object('ref_id',r.ref_id,'score',r.score,'comment',r.comment,
  'created_at',r.created_at,'customer_email',u.email)
  from ratings r join customers c on c.id=r.customer_id join users u on u.id=c.user_id
  where r.ref_type='ticket'" > out/ratings.jsonl

# identity links for §2 (billing id + email per DSP customer)
$MY "select json_object('customer_id',c.id,'billing_customer_id',c.billing_customer_id,
  'email',u.email,'name',u.name,'domain',c.domain)
  from customers c join users u on u.id=c.user_id" > out/customers.jsonl

{ for t in tickets ticket_messages ticket_internal_notes ticket_time_logs customers; do
    printf '%s ' "$t"; $MY "select count(*) from $t";
  done
  printf 'ratings_ticket '; $MY "select count(*) from ratings where ref_type='ticket'";
} > out/counts.txt

echo "== EXTRACT DONE =="; cat out/counts.txt; wc -l out/*.jsonl
