# CDB WebSphere JVM restart — refactored for 6-node Perf infra

Replaces the old 2-play / 2-role design (`debug_pst_prod_app01`, `debug_pst_prod_app02`,
hardcoded server11/12/13) with a single inventory-driven role that scales to any
number of app servers.

## Layout
    restart_jvm.yml                              top-level playbook (one play, serial)
    inventory/
      hosts.ini                                  group membership (AppNode / Core)
      group_vars/AppNode.yml                     was_profile + was_node derived from node_index
      host_vars/olb-ocbflapp00N...yml            node_index: N   (only per-host line)
    roles/debug_pst_prod/
      defaults/main.yml                          two backup paths now use {{ was_profile }}
      tasks/main.yml                             app_name ladder + resolve + stop/clear/start + check
      templates/check_application.py             UNCHANGED (byte-identical to your upload)

## How a host maps to its JVMs
node_index (host_vars) drives everything:
    profile   = OlbSrv{{ node_index }}1
    WAS node  = bolbnode{{ node_index }}1
    JVMs      = server{{ node_index }}1, server{{ node_index }}2
Add a 7th server: add one host_vars file with node_index: 7. No playbook change.

## Survey change required
`JVM Name` multiselect (variable `jvm`) options — add ALL + all 12 suffixes:
    ALL server11 server12 server21 server22 server31 server32
    server41 server42 server51 server52 server61 server62
Selecting ALL targets both JVMs on every node (of the chosen flavour).

## Ordering
serial: "{{ jvm_batch | default(1) }}"  -> 1 = rolling (one node at a time).
Override at launch: jvm_batch=100% (all parallel) or jvm_batch=N.
any_errors_fatal: true -> a failed per-node health check stops the rollout.

## Notes / open items
- WAS node name pattern (bolbnodeN1) is inferred from app01=bolbnode11, app02=bolbnode21.
  Confirm for app003-006; if irregular, set `was_node` per host instead of deriving it.
- `dry_run` currently only sets a fact and does not gate stop/start (same as the
  original). If it should actually simulate, gate the shell tasks on dry_run != "true".
