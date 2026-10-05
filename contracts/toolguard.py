# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
from datetime import datetime, timezone
import json

if "UserError" not in globals():
    UserError = gl.vm.UserError

if "bigint" not in globals():
    bigint = int


def _current_unix_timestamp() -> int:
    """Unix seconds from the transaction clock exposed as gl.message.datetime."""
    raw_dt = getattr(gl.message, "datetime", None)
    if raw_dt is None:
        raw_dt = gl.message_raw["datetime"]
    if isinstance(raw_dt, datetime):
        parsed = raw_dt
    else:
        text = str(raw_dt).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _page_text(res) -> str:
    if isinstance(res, str):
        return res
    if isinstance(res, bytes):
        return res.decode("utf-8", errors="replace")
    for attr in ("body", "text"):
        if hasattr(res, attr):
            value = getattr(res, attr)
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            if value is not None:
                return str(value)
    if isinstance(res, dict):
        value = res.get("text", res.get("body", ""))
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)
    return str(res)


def _as_confidence(raw) -> int:
    if isinstance(raw, bool) or isinstance(raw, float):
        raise UserError("confidence must be an integer from 0 to 100")
    text = str(raw).strip()
    if not text.isdigit():
        raise UserError("confidence must be an integer from 0 to 100")
    value = int(text)
    if value > 100:
        raise UserError("confidence must be an integer from 0 to 100")
    return value


def _parse_verdict(raw) -> dict:
    if isinstance(raw, dict):
        data = raw
    else:
        text = str(raw).strip()
        text = text.replace("```json", "").replace("```", "").strip()
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < start:
            raise UserError("LLM returned invalid JSON")
        try:
            data = json.loads(text[start : end + 1])
        except Exception:
            raise UserError("LLM returned invalid JSON")
    if not isinstance(data, dict):
        raise UserError("LLM returned invalid JSON")
    verdict = str(data.get("verdict", "")).strip()
    if verdict not in ("NO_DAMAGE", "DAMAGED"):
        raise UserError(f"Invalid verdict: {verdict}")
    reason = str(data.get("reason", "")).strip()
    return {
        "verdict": verdict,
        "confidence": _as_confidence(data.get("confidence", 0)),
        "reason": reason,
    }


def _leader_verdict(leader_res) -> str:
    payload = getattr(leader_res, "value", None)
    if not isinstance(payload, dict):
        payload = getattr(leader_res, "calldata", None)
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("verdict", ""))


def _nonempty_urls(urls, label: str) -> None:
    if len(urls) < 1:
        raise UserError(f"At least 1 {label} required")
    for url in urls:
        if not url or len(str(url).strip()) == 0:
            raise UserError(f"{label} cannot be empty")


@allow_storage
@dataclass
class Rental:
    owner: Address
    renter: Address
    equipment_description: str
    deposit_amount: bigint
    damaged_payout_to_owner: bigint
    rental_end_deadline: u256
    pre_rental_condition_urls: DynArray[str]
    post_rental_condition_urls: DynArray[str]
    reference_urls: DynArray[str]
    status: str
    verdict: str
    verdict_reason: str
    confidence: u256
    owner_paid: bool
    renter_refunded: bool


class ToolGuard(gl.Contract):
    owner_addr: Address
    rental_counter: bigint
    rentals: TreeMap[str, Rental]

    def __init__(self):
        self.owner_addr = gl.message.sender_address
        self.rental_counter = bigint(0)

    def _rental_view(self, rental_id: str, rental: Rental) -> dict:
        return {
            "id": rental_id,
            "owner": str(rental.owner),
            "renter": str(rental.renter),
            "equipment_description": rental.equipment_description,
            "deposit_amount": str(rental.deposit_amount),
            "damaged_payout_to_owner": str(rental.damaged_payout_to_owner),
            "rental_end_deadline": str(rental.rental_end_deadline),
            "pre_rental_condition_urls": [str(url) for url in rental.pre_rental_condition_urls],
            "post_rental_condition_urls": [str(url) for url in rental.post_rental_condition_urls],
            "reference_urls": [str(url) for url in rental.reference_urls],
            "status": rental.status,
            "verdict": rental.verdict,
            "verdict_reason": rental.verdict_reason,
            "confidence": str(rental.confidence),
            "owner_paid": rental.owner_paid,
            "renter_refunded": rental.renter_refunded,
        }

    @gl.public.view
    def get_deployer(self) -> str:
        return str(self.owner_addr)

    @gl.public.view
    def get_rental_count(self) -> str:
        return str(self.rental_counter)

    @gl.public.view
    def get_rental(self, rental_id: str) -> dict:
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        return self._rental_view(rental_id, self.rentals[rental_id])

    @gl.public.write.payable
    def create_rental(
        self,
        owner: Address,
        equipment_description: str,
        damaged_payout_to_owner: bigint,
        rental_end_deadline: u256,
    ) -> str:
        deposit = bigint(int(gl.message.value))
        if deposit <= bigint(0):
            raise UserError("Must send GEN as deposit (amount must be > 0)")
        if not equipment_description or len(equipment_description.strip()) == 0:
            raise UserError("Equipment description cannot be empty")
        if owner == gl.message.sender_address:
            raise UserError("Renter and owner cannot be the same address")
        if damaged_payout_to_owner <= bigint(0) or damaged_payout_to_owner >= deposit:
            raise UserError(
                "damaged_payout_to_owner must be > 0 and strictly less than deposit_amount"
            )

        rental_id = str(self.rental_counter)
        self.rental_counter = self.rental_counter + bigint(1)
        self.rentals[rental_id] = Rental(
            owner=owner,
            renter=gl.message.sender_address,
            equipment_description=equipment_description,
            deposit_amount=deposit,
            damaged_payout_to_owner=damaged_payout_to_owner,
            rental_end_deadline=rental_end_deadline,
            pre_rental_condition_urls=[],
            post_rental_condition_urls=[],
            reference_urls=[],
            status="AWAITING_HANDOVER",
            verdict="",
            verdict_reason="",
            confidence=u256(0),
            owner_paid=False,
            renter_refunded=False,
        )
        return rental_id

    @gl.public.write
    def submit_handover_condition(
        self, rental_id: str, pre_rental_condition_urls: DynArray[str]
    ) -> None:
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        rental = self.rentals[rental_id]
        if gl.message.sender_address != rental.owner:
            raise UserError("Only owner can submit handover condition")
        if rental.status != "AWAITING_HANDOVER":
            raise UserError(f"Cannot submit handover condition in status: {rental.status}")
        _nonempty_urls(pre_rental_condition_urls, "pre-rental condition URL")
        rental.pre_rental_condition_urls = pre_rental_condition_urls
        rental.status = "RENTED"
        self.rentals[rental_id] = rental

    @gl.public.write
    def report_return(
        self,
        rental_id: str,
        post_rental_condition_urls: DynArray[str],
        reference_urls: DynArray[str],
    ) -> None:
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        rental = self.rentals[rental_id]
        if gl.message.sender_address != rental.renter:
            raise UserError("Only renter can report return")
        if rental.status not in ["RENTED", "DISPUTED"]:
            raise UserError(f"Cannot report return in status: {rental.status}")
        _nonempty_urls(post_rental_condition_urls, "post-rental condition URL")
        rental.post_rental_condition_urls = post_rental_condition_urls
        rental.reference_urls = reference_urls
        rental.status = "RETURN_REPORTED"
        rental.verdict = ""
        rental.verdict_reason = ""
        rental.confidence = u256(0)
        self.rentals[rental_id] = rental

    @gl.public.write
    def resolve_rental(self, rental_id: str) -> None:
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        rental = self.rentals[rental_id]
        if rental.status != "RETURN_REPORTED":
            raise UserError(f"Rental not ready for resolution (status: {rental.status})")

        equipment_desc = rental.equipment_description
        pre_urls_list = list(rental.pre_rental_condition_urls)
        post_urls_list = list(rental.post_rental_condition_urls)
        reference_urls_list = list(rental.reference_urls)

        def leader_fn() -> dict:
            pre_contents = []
            for url in pre_urls_list:
                try:
                    pre_contents.append(f"[{url}]: {_page_text(gl.nondet.web.render(url))}")
                except Exception:
                    raise UserError(f"Failed to fetch pre-rental URL: {url}")

            post_contents = []
            for url in post_urls_list:
                try:
                    post_contents.append(f"[{url}]: {_page_text(gl.nondet.web.render(url))}")
                except Exception:
                    raise UserError(f"Failed to fetch post-rental URL: {url}")

            reference_contents = []
            for url in reference_urls_list:
                try:
                    reference_contents.append(f"[{url}]: {_page_text(gl.nondet.web.render(url))}")
                except Exception:
                    pass

            prompt = f"""You are a neutral peer-to-peer equipment rental condition adjudicator.
Equipment: "{equipment_desc}"
Condition BEFORE rental (submitted by owner, before handover): {pre_contents}
Condition AFTER rental (submitted by renter, at return): {post_contents}
Additional supporting evidence (optional, may be empty): {reference_contents}

Decide strictly one of two outcomes by comparing before vs after condition:
- "NO_DAMAGE": the equipment's condition after rental is consistent with before — no new, significant damage.
- "DAMAGED": there is clear new damage/deterioration visible when comparing after vs before.

Return ONLY raw JSON, no markdown:
{{"verdict": "NO_DAMAGE" | "DAMAGED", "confidence": <0-100>, "reason": "<short justification>"}}"""

            return _parse_verdict(gl.nondet.exec_prompt(prompt))

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            try:
                my_res = leader_fn()
            except Exception:
                return False
            return my_res["verdict"] == _leader_verdict(leader_res)

        result = gl.vm.run_nondet(leader_fn, validator_fn)
        rental.verdict = result["verdict"]
        rental.confidence = u256(result["confidence"])
        rental.verdict_reason = result["reason"]
        if result["confidence"] < 60:
            rental.status = "DISPUTED"
            self.rentals[rental_id] = rental
            return

        self.rentals[rental_id] = rental
        self._execute_settlement(rental_id)

    def _execute_settlement(self, rental_id: str) -> None:
        """Pay the unpaid side only. Successful flags are never cleared."""
        rental = self.rentals[rental_id]
        any_failure = False
        forfeit = rental.verdict == ""

        if rental.verdict == "NO_DAMAGE":
            if not rental.renter_refunded:
                try:
                    gl.get_contract_at(rental.renter).emit_transfer(
                        value=u256(rental.deposit_amount)
                    )
                    rental.renter_refunded = True
                except Exception as exc:
                    any_failure = True
                    rental.verdict_reason += f" (Renter refund failed: {str(exc)})"
        elif rental.verdict == "DAMAGED":
            refund_to_renter = rental.deposit_amount - rental.damaged_payout_to_owner
            if not rental.owner_paid:
                try:
                    gl.get_contract_at(rental.owner).emit_transfer(
                        value=u256(rental.damaged_payout_to_owner)
                    )
                    rental.owner_paid = True
                except Exception as exc:
                    any_failure = True
                    rental.verdict_reason += f" (Owner partial payout failed: {str(exc)})"
            if not rental.renter_refunded:
                try:
                    gl.get_contract_at(rental.renter).emit_transfer(value=u256(refund_to_renter))
                    rental.renter_refunded = True
                except Exception as exc:
                    any_failure = True
                    rental.verdict_reason += f" (Renter refund failed: {str(exc)})"
        elif forfeit:
            if not rental.owner_paid:
                try:
                    gl.get_contract_at(rental.owner).emit_transfer(
                        value=u256(rental.deposit_amount)
                    )
                    rental.owner_paid = True
                except Exception as exc:
                    any_failure = True
                    rental.verdict_reason = f"Forfeit payout failed: {str(exc)}"
        else:
            raise UserError("Nothing to settle")

        if any_failure:
            rental.status = "PAYOUT_FAILED"
        elif forfeit:
            rental.status = "EXPIRED_FORFEITED"
        else:
            rental.status = "RESOLVED"
        self.rentals[rental_id] = rental

    @gl.public.write
    def retry_resolution(self, rental_id: str) -> None:
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        rental = self.rentals[rental_id]
        if gl.message.sender_address != rental.owner and gl.message.sender_address != rental.renter:
            raise UserError("Only owner or renter can retry")
        if rental.status != "PAYOUT_FAILED":
            raise UserError("Can only retry PAYOUT_FAILED rentals")
        self._execute_settlement(rental_id)

    @gl.public.write
    def claim_no_return_forfeit(self, rental_id: str) -> None:
        """Owner receives the full deposit if the renter never reported a return."""
        if rental_id not in self.rentals:
            raise UserError("Rental does not exist")
        rental = self.rentals[rental_id]
        if gl.message.sender_address != rental.owner:
            raise UserError("Only owner can claim this forfeiture")
        if rental.status != "RENTED":
            raise UserError("Can only claim if renter never reported return")
        if _current_unix_timestamp() <= int(rental.rental_end_deadline):
            raise UserError("Rental deadline has not passed yet")
        self._execute_settlement(rental_id)
