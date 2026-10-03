import json
import re

import gltest.direct.loader as loader

DEPOSIT = 10 * 10**18
PAYOUT = 4 * 10**18
REFUND = DEPOSIT - PAYOUT
FUTURE = 4_102_444_800
PAST = 1
PRE = "https://evidence.example/before"
POST = "https://evidence.example/after"
REF = "https://evidence.example/listing"
CONTRACT_PATH = "contracts/toolguard.py"

_fail_recipients = set()
_original_emit = loader._EOAProxy.emit_transfer


def _emit_transfer(self, value=None, **kwargs):
    amount = int(value)
    if amount <= 0:
        raise ValueError("value must be greater than 0 for emit_transfer")
    key = loader._normalize_addr(self.address)
    if key in _fail_recipients:
        raise RuntimeError(f"transfer rejected for {key}")
    vm = loader._get_active_vm()
    if vm is not None:
        sender = getattr(vm, "_contract_address", None)
        if sender is not None:
            sender_bytes = vm._to_bytes(sender)
            balance = vm._balances.get(sender_bytes, 0)
            if balance < amount:
                raise RuntimeError("insufficient contract balance")
            vm._balances[sender_bytes] = balance - amount
        recipient_bytes = vm._to_bytes(self.address)
        vm._balances[recipient_bytes] = vm._balances.get(recipient_bytes, 0) + amount
    return self


loader._EOAProxy.emit_transfer = _emit_transfer


def _as_address(raw):
    from genlayer.py.types import Address

    if isinstance(raw, Address):
        return raw
    return Address(raw)


def _balance(vm, address) -> int:
    return vm._balances.get(vm._to_bytes(_as_address(address)), 0)


def _fail(address) -> None:
    _fail_recipients.add(loader._normalize_addr(_as_address(address)))


def _clear_failures() -> None:
    _fail_recipients.clear()


def sim_install_mocks(vm, verdict: str, confidence: int, *, reference: bool = False, skip_pre: bool = False, skip_post: bool = False, raw_llm: str | None = None) -> None:
    """Install web and LLM mocks before a nondet transaction.

    Direct gltest uses vm.mock_web / vm.mock_llm. When a simulator provider is
    present, the same payload is also sent as RPC sim_installMocks.
    """
    vm.clear_mocks()
    pages = {}
    if not skip_pre:
        pages[PRE] = "before: intact housing, no cracks"
    if not skip_post:
        pages[POST] = "after: condition photo at return"
    if reference:
        pages[REF] = "optional listing photo"
    for url, body in pages.items():
        vm.mock_web(re.escape(url), {"status": 200, "body": body, "method": "GET"})
    if raw_llm is None:
        raw_llm = json.dumps(
            {
                "verdict": verdict,
                "confidence": confidence,
                "reason": "compared before and after photos",
            }
        )
    vm.mock_llm(r"equipment rental condition", raw_llm)
    provider = getattr(vm, "provider", None)
    if provider is not None and hasattr(provider, "make_request"):
        provider.make_request(
            method="sim_installMocks",
            params=[{"web": pages, "llm": {"equipment rental condition": raw_llm}}],
        )


def _deploy(direct_deploy):
    _clear_failures()
    return direct_deploy(CONTRACT_PATH)


def _rent(vm, contract, renter, owner, deadline=FUTURE):
    renter = _as_address(renter)
    owner = _as_address(owner)
    vm.sender = renter
    vm.value = DEPOSIT
    rental_id = contract.create_rental(owner, "May khoan cam tay", PAYOUT, deadline)
    vm.deal(contract.address, _balance(vm, contract.address) + DEPOSIT)
    vm.value = 0
    return rental_id


def _handover(vm, contract, renter, owner, deadline=FUTURE):
    rental_id = _rent(vm, contract, renter, owner, deadline)
    vm.sender = owner
    contract.submit_handover_condition(rental_id, [PRE])
    return rental_id


def _ready(vm, contract, renter, owner, deadline=FUTURE, reference=False):
    rental_id = _handover(vm, contract, renter, owner, deadline)
    vm.sender = renter
    refs = [REF] if reference else []
    contract.report_return(rental_id, [POST], refs)
    return rental_id


def test_no_damage_pays_full_deposit_to_renter(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 91)
    contract.resolve_rental(rental_id)
    rental = contract.get_rental(rental_id)
    assert rental["status"] == "RESOLVED"
    assert rental["verdict"] == "NO_DAMAGE"
    assert rental["renter_refunded"] is True
    assert rental["owner_paid"] is False
    assert _balance(direct_vm, direct_alice) == DEPOSIT
    assert _balance(direct_vm, direct_bob) == 0
    assert direct_vm.run_validator() is True


def test_damaged_splits_fixed_amounts(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    sim_install_mocks(direct_vm, "DAMAGED", 88)
    contract.resolve_rental(rental_id)
    rental = contract.get_rental(rental_id)
    assert rental["status"] == "RESOLVED"
    assert rental["verdict"] == "DAMAGED"
    assert rental["owner_paid"] is True
    assert rental["renter_refunded"] is True
    assert _balance(direct_vm, direct_bob) == PAYOUT
    assert _balance(direct_vm, direct_alice) == REFUND


def test_forfeit_pays_owner_full_deposit(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _handover(direct_vm, contract, direct_alice, direct_bob, PAST)
    direct_vm.sender = _as_address(direct_bob)
    contract.claim_no_return_forfeit(rental_id)
    rental = contract.get_rental(rental_id)
    assert rental["status"] == "EXPIRED_FORFEITED"
    assert rental["verdict"] == ""
    assert rental["owner_paid"] is True
    assert _balance(direct_vm, direct_bob) == DEPOSIT
    assert _balance(direct_vm, direct_alice) == 0


def test_return_before_handover_is_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _rent(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = _as_address(direct_alice)
    with direct_vm.expect_revert("Cannot report return"):
        contract.report_return(rental_id, [POST], [])
    assert contract.get_rental(rental_id)["status"] == "AWAITING_HANDOVER"


def test_low_confidence_disputed_then_reresolve(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    sim_install_mocks(direct_vm, "DAMAGED", 42)
    contract.resolve_rental(rental_id)
    disputed = contract.get_rental(rental_id)
    assert disputed["status"] == "DISPUTED"
    assert disputed["confidence"] == "42"
    assert _balance(direct_vm, direct_alice) == 0
    assert _balance(direct_vm, direct_bob) == 0

    direct_vm.sender = _as_address(direct_alice)
    contract.report_return(rental_id, [POST], [REF])
    sim_install_mocks(direct_vm, "NO_DAMAGE", 93, reference=True)
    contract.resolve_rental(rental_id)
    resolved = contract.get_rental(rental_id)
    assert resolved["status"] == "RESOLVED"
    assert resolved["verdict"] == "NO_DAMAGE"
    assert _balance(direct_vm, direct_alice) == DEPOSIT


def test_required_web_failure_and_bad_json_revert(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob, reference=True)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90, reference=True, skip_pre=True)
    with direct_vm.expect_revert("Failed to fetch pre-rental URL"):
        contract.resolve_rental(rental_id)
    assert contract.get_rental(rental_id)["status"] == "RETURN_REPORTED"

    sim_install_mocks(direct_vm, "NO_DAMAGE", 90, reference=True, skip_post=True)
    with direct_vm.expect_revert("Failed to fetch post-rental URL"):
        contract.resolve_rental(rental_id)

    sim_install_mocks(direct_vm, "NO_DAMAGE", 90, raw_llm="not-json")
    with direct_vm.expect_revert("invalid JSON"):
        contract.resolve_rental(rental_id)


def test_optional_reference_fetch_failure_is_ignored(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob, reference=True)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90, reference=False)
    contract.resolve_rental(rental_id)
    assert contract.get_rental(rental_id)["status"] == "RESOLVED"
    assert _balance(direct_vm, direct_alice) == DEPOSIT


def test_invalid_payout_and_same_party_are_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    direct_vm.sender = _as_address(direct_alice)
    direct_vm.value = DEPOSIT
    with direct_vm.expect_revert("cannot be the same address"):
        contract.create_rental(_as_address(direct_alice), "May khoan", PAYOUT, FUTURE)
    with direct_vm.expect_revert("strictly less than deposit"):
        contract.create_rental(_as_address(direct_bob), "May khoan", DEPOSIT, FUTURE)
    with direct_vm.expect_revert("strictly less than deposit"):
        contract.create_rental(_as_address(direct_bob), "May khoan", 0, FUTURE)
    direct_vm.value = 0
    with direct_vm.expect_revert("amount must be > 0"):
        contract.create_rental(_as_address(direct_bob), "May khoan", PAYOUT, FUTURE)
    assert contract.get_rental_count() == "0"


def test_double_actions_are_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = _as_address(direct_bob)
    with direct_vm.expect_revert("Cannot submit handover"):
        contract.submit_handover_condition(rental_id, [PRE])
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90)
    contract.resolve_rental(rental_id)
    with direct_vm.expect_revert("not ready for resolution"):
        contract.resolve_rental(rental_id)
    direct_vm.sender = _as_address(direct_alice)
    with direct_vm.expect_revert("Cannot report return"):
        contract.report_return(rental_id, [POST], [])


def test_forfeit_before_deadline_and_wrong_caller_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _handover(direct_vm, contract, direct_alice, direct_bob, FUTURE)
    direct_vm.sender = _as_address(direct_bob)
    with direct_vm.expect_revert("deadline has not passed"):
        contract.claim_no_return_forfeit(rental_id)
    direct_vm.sender = _as_address(direct_alice)
    with direct_vm.expect_revert("Only owner"):
        contract.claim_no_return_forfeit(rental_id)
    assert contract.get_rental(rental_id)["status"] == "RENTED"


def test_no_damage_transfer_fail_then_retry_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    _fail(direct_alice)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90)
    contract.resolve_rental(rental_id)
    failed = contract.get_rental(rental_id)
    assert failed["status"] == "PAYOUT_FAILED"
    assert failed["renter_refunded"] is False
    assert _balance(direct_vm, direct_alice) == 0

    _clear_failures()
    direct_vm.sender = _as_address(direct_alice)
    contract.retry_resolution(rental_id)
    assert contract.get_rental(rental_id)["status"] == "RESOLVED"
    assert _balance(direct_vm, direct_alice) == DEPOSIT
    with direct_vm.expect_revert("Can only retry PAYOUT_FAILED"):
        contract.retry_resolution(rental_id)
    assert _balance(direct_vm, direct_alice) == DEPOSIT


def _reset_balances(vm, *addresses):
    for address in addresses:
        vm.deal(address, 0)


def test_damaged_partial_failures_retry_only_missing_side(direct_vm, direct_deploy, direct_alice, direct_bob):
    _reset_balances(direct_vm, direct_alice, direct_bob)
    owner_only = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, owner_only, direct_alice, direct_bob)
    _fail(direct_bob)
    sim_install_mocks(direct_vm, "DAMAGED", 90)
    owner_only.resolve_rental(rental_id)
    state = owner_only.get_rental(rental_id)
    assert state["status"] == "PAYOUT_FAILED"
    assert state["owner_paid"] is False
    assert state["renter_refunded"] is True
    assert _balance(direct_vm, direct_alice) == REFUND
    assert _balance(direct_vm, direct_bob) == 0
    _clear_failures()
    direct_vm.sender = _as_address(direct_bob)
    owner_only.retry_resolution(rental_id)
    assert owner_only.get_rental(rental_id)["owner_paid"] is True
    assert _balance(direct_vm, direct_bob) == PAYOUT
    assert _balance(direct_vm, direct_alice) == REFUND
    with direct_vm.expect_revert("Can only retry PAYOUT_FAILED"):
        owner_only.retry_resolution(rental_id)
    assert _balance(direct_vm, direct_bob) == PAYOUT
    assert _balance(direct_vm, direct_alice) == REFUND

    _reset_balances(direct_vm, direct_alice, direct_bob)
    renter_only = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, renter_only, direct_alice, direct_bob)
    _fail(direct_alice)
    sim_install_mocks(direct_vm, "DAMAGED", 90)
    renter_only.resolve_rental(rental_id)
    state = renter_only.get_rental(rental_id)
    assert state["owner_paid"] is True
    assert state["renter_refunded"] is False
    assert _balance(direct_vm, direct_bob) == PAYOUT
    assert _balance(direct_vm, direct_alice) == 0
    _clear_failures()
    renter_only.retry_resolution(rental_id)
    assert _balance(direct_vm, direct_alice) == REFUND
    assert _balance(direct_vm, direct_bob) == PAYOUT

    _reset_balances(direct_vm, direct_alice, direct_bob)
    both = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, both, direct_alice, direct_bob)
    _fail(direct_alice)
    _fail(direct_bob)
    sim_install_mocks(direct_vm, "DAMAGED", 90)
    both.resolve_rental(rental_id)
    state = both.get_rental(rental_id)
    assert state["status"] == "PAYOUT_FAILED"
    assert state["owner_paid"] is False
    assert state["renter_refunded"] is False
    assert _balance(direct_vm, direct_alice) == 0
    assert _balance(direct_vm, direct_bob) == 0
    _clear_failures()
    both.retry_resolution(rental_id)
    assert both.get_rental(rental_id)["status"] == "RESOLVED"
    assert _balance(direct_vm, direct_bob) == PAYOUT
    assert _balance(direct_vm, direct_alice) == REFUND


def test_forfeit_transfer_fail_then_retry_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _handover(direct_vm, contract, direct_alice, direct_bob, PAST)
    _fail(direct_bob)
    direct_vm.sender = _as_address(direct_bob)
    contract.claim_no_return_forfeit(rental_id)
    failed = contract.get_rental(rental_id)
    assert failed["status"] == "PAYOUT_FAILED"
    assert failed["owner_paid"] is False
    assert _balance(direct_vm, direct_bob) == 0
    _clear_failures()
    contract.retry_resolution(rental_id)
    restored = contract.get_rental(rental_id)
    assert restored["status"] == "EXPIRED_FORFEITED"
    assert restored["owner_paid"] is True
    assert _balance(direct_vm, direct_bob) == DEPOSIT
    with direct_vm.expect_revert("Can only retry PAYOUT_FAILED"):
        contract.retry_resolution(rental_id)
    assert _balance(direct_vm, direct_bob) == DEPOSIT


def test_stranger_cannot_retry(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    _fail(direct_alice)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90)
    contract.resolve_rental(rental_id)
    direct_vm.sender = _as_address(direct_charlie)
    with direct_vm.expect_revert("Only owner or renter"):
        contract.retry_resolution(rental_id)


def test_validator_rejects_a_different_binary_verdict(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy)
    rental_id = _ready(direct_vm, contract, direct_alice, direct_bob)
    sim_install_mocks(direct_vm, "NO_DAMAGE", 90)
    contract.resolve_rental(rental_id)
    sim_install_mocks(direct_vm, "DAMAGED", 90)
    assert direct_vm.run_validator() is False
