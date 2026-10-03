import { useEffect, useMemo, useState } from "react";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  connectStudionet,
  createReadClient,
  hasContract,
  readRental,
  readRentalCount,
  writeAndWait,
} from "./genlayer";
import {
  deadlineUnix,
  formatWeiToGen,
  isValidPayout,
  parseGenToWei,
  payoutWeiFromPercent,
  subtractWei,
} from "./money";

const CATEGORIES = ["Dụng cụ cầm tay", "Thiết bị điện tử", "Xe đạp-xe máy", "Đồ cắm trại", "Khác"];
const DEPOSIT_CHIPS = ["1", "5", "10", "20", "50"];
const PAYOUT_PERCENTS = [10, 25, 50, 75];
const DEADLINES = [
  { days: 1, label: "1 ngày" },
  { days: 3, label: "3 ngày" },
  { days: 7, label: "7 ngày" },
  { days: 14, label: "14 ngày" },
];

const STATUS_LABEL = {
  AWAITING_HANDOVER: "Chờ owner nộp ảnh trước khi giao",
  RENTED: "Đang thuê",
  RETURN_REPORTED: "Đã báo trả, chờ AI phân xử",
  RESOLVED: "Đã phân xử",
  DISPUTED: "Chưa đủ chắc, cần bằng chứng rõ hơn",
  PAYOUT_FAILED: "Trả tiền bị lỗi một phần",
  EXPIRED_FORFEITED: "Quá hạn, cọc bị tịch thu",
};

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

function UrlEditor({ label, urls, onChange }) {
  const update = (index, next) => {
    const copy = urls.slice();
    copy[index] = next;
    onChange(copy);
  };
  return (
    <div className="urls">
      <span>{label}</span>
      {urls.map((url, index) => (
        <div className="url-row" key={`${label}-${index}`}>
          <input
            value={url}
            placeholder="https://..."
            onChange={(event) => update(index, event.target.value)}
          />
          <button
            type="button"
            onClick={async () => {
              const text = await navigator.clipboard.readText();
              update(index, text.trim());
            }}
          >
            Dán
          </button>
          {urls.length > 1 ? (
            <button type="button" onClick={() => onChange(urls.filter((_, i) => i !== index))}>
              Xóa
            </button>
          ) : null}
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange(urls.concat(""))}>
        Thêm link
      </button>
    </div>
  );
}

function settlementText(rental) {
  const deposit = BigInt(String(rental.deposit_amount || "0"));
  const payout = BigInt(String(rental.damaged_payout_to_owner || "0"));
  const refund = subtractWei(deposit, payout);
  if (rental.status === "EXPIRED_FORFEITED" || (rental.status === "PAYOUT_FAILED" && !rental.verdict)) {
    return `Owner nhận toàn bộ cọc ${formatWeiToGen(deposit)} GEN nếu lần chuyển thành công.`;
  }
  if (rental.verdict === "DAMAGED") {
    return `Owner nhận ${formatWeiToGen(payout)} GEN. Renter nhận lại ${formatWeiToGen(refund)} GEN.`;
  }
  if (rental.verdict === "NO_DAMAGE") {
    return `Renter nhận lại đủ cọc ${formatWeiToGen(deposit)} GEN.`;
  }
  return `Nếu không hỏng, renter nhận ${formatWeiToGen(deposit)} GEN. Nếu hỏng, owner nhận ${formatWeiToGen(payout)} GEN và renter nhận ${formatWeiToGen(refund)} GEN.`;
}

export default function App() {
  const contractReady = hasContract();
  const [account, setAccount] = useState("");
  const [writeClient, setWriteClient] = useState(null);
  const [rentals, setRentals] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [depositText, setDepositText] = useState("5");
  const [payoutPercent, setPayoutPercent] = useState(25);
  const [customPayout, setCustomPayout] = useState("");
  const [useCustomPayout, setUseCustomPayout] = useState(false);
  const [days, setDays] = useState(7);
  const [preUrls, setPreUrls] = useState({});
  const [postUrls, setPostUrls] = useState({});
  const [refUrls, setRefUrls] = useState({});

  const depositWei = useMemo(() => parseGenToWei(depositText), [depositText]);
  const payoutWei = useMemo(() => {
    if (useCustomPayout) return parseGenToWei(customPayout);
    return payoutWeiFromPercent(depositWei, payoutPercent);
  }, [useCustomPayout, customPayout, depositWei, payoutPercent]);
  const payoutOk = isValidPayout(depositWei, payoutWei);

  async function refresh(reader = writeClient) {
    if (!contractReady) {
      setRentals([]);
      return;
    }
    const readClient = reader?.readContract ? reader : createReadClient();
    setLoadingList(true);
    setError("");
    try {
      const count = await readRentalCount(readClient);
      const next = [];
      let index = 0n;
      while (index < count) {
        next.push(await readRental(readClient, index.toString()));
        index += 1n;
      }
      setRentals(next.reverse());
    } catch (err) {
      setError(err?.message || "Không đọc được contract.");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    if (!contractReady) return;
    refresh(null);
  }, [contractReady]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccounts = (accounts) => setAccount(accounts?.[0] || "");
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccounts);
  }, []);

  async function connect() {
    setError("");
    try {
      const session = await connectStudionet();
      setAccount(session.address);
      setWriteClient(session);
      setNotice(`Đã nối ví trên ${CHAIN.name || "studionet"}.`);
      await refresh(session.readClient);
    } catch (err) {
      setError(err?.message || "Không nối được ví.");
    }
  }

  async function runTx(key, fn) {
    if (!contractReady) {
      setError("Chưa có địa chỉ contract. App chỉ xem trước giao diện.");
      return;
    }
    if (!writeClient) {
      setError("Hãy nối MetaMask trên studionet trước.");
      return;
    }
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice("Giao dịch đã được chấp nhận. Đang đọc lại trạng thái.");
      await refresh(writeClient.readClient);
    } catch (err) {
      setError(err?.message || "Giao dịch thất bại.");
    } finally {
      setBusy("");
    }
  }

  async function createRental(event) {
    event.preventDefault();
    if (!payoutOk) {
      setError("Mức bồi thường phải lớn hơn 0 và nhỏ hơn tiền cọc.");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(owner.trim())) {
      setError("Địa chỉ owner không hợp lệ.");
      return;
    }
    if (sameAddress(owner, account)) {
      setError("Renter và owner phải là hai ví khác nhau.");
      return;
    }
    const text = description.trim();
    if (!text) {
      setError("Hãy mô tả ngắn thiết bị.");
      return;
    }
    await runTx("create", async () => {
      const count = await readRentalCount(writeClient.readClient);
      await writeAndWait(
        writeClient.writeClient,
        writeClient.readClient,
        "create_rental",
        [owner.trim(), `${category}: ${text}`, payoutWei, deadlineUnix(days)],
        depositWei
      );
      setNotice(`Đã tạo đơn #${count.toString()}.`);
      setDescription("");
    });
  }

  function urlsFor(map, id) {
    return map[id]?.length ? map[id] : [""];
  }

  return (
    <div className="page">
      <div className="banner">
        Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.
      </div>
      {!contractReady ? (
        <div className="banner warn">
          Chưa có địa chỉ contract. Đặt VITE_CONTRACT_ADDRESS sau khi deploy studionet thành công. Trang này vẫn mở được, các nút gửi giao dịch đang tắt.
        </div>
      ) : null}

      <header className="top">
        <div>
          <p className="eyebrow">Sharing economy · studionet</p>
          <h1>ToolGuard</h1>
          <p className="lede">
            Cọc thuê thiết bị giữa cá nhân. Owner chụp tình trạng trước khi giao, renter chụp lúc trả. AI đối chiếu và chỉ chọn không hỏng hoặc có hỏng.
          </p>
        </div>
        <div className="wallet">
          <button type="button" onClick={connect}>
            {account ? "Đổi ví" : "Nối MetaMask"}
          </button>
          <small>{account || "Chưa nối ví"}</small>
          <small>{contractReady ? CONTRACT_ADDRESS : "Chưa gắn contract"}</small>
        </div>
      </header>

      {error ? <p className="flash bad">{error}</p> : null}
      {notice ? <p className="flash ok">{notice}</p> : null}

      <section className="panel">
        <h2>Tạo đơn thuê</h2>
        <form onSubmit={createRental}>
          <label>
            Loại thiết bị
            <div className="chips">
              {CATEGORIES.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={item === category ? "chip on" : "chip"}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </label>
          <label>
            Mô tả ngắn
            <input
              value={description}
              maxLength={180}
              placeholder="Máy khoan pin, thân xám, đầu mũi 10mm"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            Địa chỉ owner
            <div className="url-row">
              <input value={owner} placeholder="0x..." onChange={(event) => setOwner(event.target.value)} />
              <button
                type="button"
                onClick={async () => setOwner((await navigator.clipboard.readText()).trim())}
              >
                Dán
              </button>
            </div>
          </label>
          <label>
            Tiền cọc (GEN)
            <div className="chips">
              {DEPOSIT_CHIPS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={depositText === item ? "chip on" : "chip"}
                  onClick={() => setDepositText(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <input value={depositText} inputMode="decimal" onChange={(event) => setDepositText(event.target.value)} />
          </label>
          <label>
            Bồi thường nếu hỏng
            <div className="chips">
              {PAYOUT_PERCENTS.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={!useCustomPayout && payoutPercent === item ? "chip on" : "chip"}
                  onClick={() => {
                    setUseCustomPayout(false);
                    setPayoutPercent(item);
                  }}
                >
                  {item}% cọc
                </button>
              ))}
              <button
                type="button"
                className={useCustomPayout ? "chip on" : "chip"}
                onClick={() => setUseCustomPayout(true)}
              >
                Tự nhập
              </button>
            </div>
            {useCustomPayout ? (
              <input
                value={customPayout}
                inputMode="decimal"
                placeholder="GEN"
                onChange={(event) => setCustomPayout(event.target.value)}
              />
            ) : null}
          </label>
          <label>
            Hạn trả đồ
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {DEADLINES.map((item) => (
                <option key={item.days} value={item.days}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="preview">
            Cọc {formatWeiToGen(depositWei)} GEN. Nếu hỏng, owner nhận {formatWeiToGen(payoutWei)} GEN, renter nhận lại{" "}
            {formatWeiToGen(subtractWei(depositWei, payoutWei))} GEN. Nếu không hỏng, renter nhận lại đủ cọc.
          </p>
          <button type="submit" disabled={!contractReady || !payoutOk || busy === "create"}>
            {busy === "create" ? "Đang gửi cọc..." : "Gửi cọc và tạo đơn"}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="row">
          <h2>Đơn thuê</h2>
          <button type="button" className="ghost" onClick={() => refresh(writeClient?.readClient)} disabled={!contractReady || loadingList}>
            {loadingList ? "Đang đọc..." : "Tải lại"}
          </button>
        </div>
        {!contractReady ? <p>Danh sách sẽ hiện sau khi có địa chỉ contract.</p> : null}
        {contractReady && rentals.length === 0 && !loadingList ? <p>Chưa có đơn nào trên contract này.</p> : null}
        {rentals.map((rental) => {
          const id = String(rental.id);
          const mineOwner = sameAddress(account, rental.owner);
          const mineRenter = sameAddress(account, rental.renter);
          const deadline = BigInt(String(rental.rental_end_deadline || "0"));
          const now = BigInt(Date.now()) / 1000n;
          const overdue = now > deadline && rental.status === "RENTED";
          return (
            <article className="card" key={id}>
              <header>
                <strong>Đơn #{id}</strong>
                <span>{STATUS_LABEL[rental.status] || rental.status}</span>
              </header>
              <p>{rental.equipment_description}</p>
              <p className="meta">
                Owner {rental.owner}
                <br />
                Renter {rental.renter}
              </p>
              <p>{settlementText(rental)}</p>
              {rental.verdict ? (
                <p className="verdict">
                  {rental.verdict} · độ chắc {rental.confidence}/100
                  <br />
                  {rental.verdict_reason}
                </p>
              ) : null}
              {rental.status === "PAYOUT_FAILED" || rental.owner_paid || rental.renter_refunded ? (
                <ul className="flags">
                  <li>Owner đã nhận: {rental.owner_paid ? "rồi" : "chưa"}</li>
                  <li>Renter đã được hoàn: {rental.renter_refunded ? "rồi" : "chưa"}</li>
                </ul>
              ) : null}
              <p className="hint">
                Owner nên chụp ảnh TRƯỚC khi giao, renter nên chụp ảnh NGAY LÚC trả — càng rõ góc độ, càng dễ AI đối chiếu.
              </p>

              {rental.status === "AWAITING_HANDOVER" && mineOwner ? (
                <div>
                  <UrlEditor
                    label="Ảnh / link tình trạng trước khi giao"
                    urls={urlsFor(preUrls, id)}
                    onChange={(next) => setPreUrls({ ...preUrls, [id]: next })}
                  />
                  <button
                    type="button"
                    disabled={busy === `hand-${id}`}
                    onClick={() =>
                      runTx(`hand-${id}`, () =>
                        writeAndWait(writeClient.writeClient, writeClient.readClient, "submit_handover_condition", [
                          id,
                          urlsFor(preUrls, id).map((item) => item.trim()).filter(Boolean),
                        ])
                      )
                    }
                  >
                    {busy === `hand-${id}` ? "Đang gửi..." : "Xác nhận đã giao"}
                  </button>
                </div>
              ) : null}

              {(rental.status === "RENTED" || rental.status === "DISPUTED") && mineRenter ? (
                <div>
                  <UrlEditor
                    label="Ảnh / link tình trạng lúc trả"
                    urls={urlsFor(postUrls, id)}
                    onChange={(next) => setPostUrls({ ...postUrls, [id]: next })}
                  />
                  <UrlEditor
                    label="Nguồn bổ sung, có thể bỏ trống"
                    urls={urlsFor(refUrls, id)}
                    onChange={(next) => setRefUrls({ ...refUrls, [id]: next })}
                  />
                  <button
                    type="button"
                    disabled={busy === `ret-${id}`}
                    onClick={() =>
                      runTx(`ret-${id}`, () =>
                        writeAndWait(writeClient.writeClient, writeClient.readClient, "report_return", [
                          id,
                          urlsFor(postUrls, id).map((item) => item.trim()).filter(Boolean),
                          urlsFor(refUrls, id).map((item) => item.trim()).filter(Boolean),
                        ])
                      )
                    }
                  >
                    {busy === `ret-${id}` ? "Đang gửi..." : rental.status === "DISPUTED" ? "Nộp lại bằng chứng" : "Báo đã trả đồ"}
                  </button>
                </div>
              ) : null}

              {rental.status === "RETURN_REPORTED" ? (
                <button
                  type="button"
                  disabled={!contractReady || busy === `ai-${id}`}
                  onClick={() =>
                    runTx(`ai-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "resolve_rental", [id])
                    )
                  }
                >
                  {busy === `ai-${id}` ? "AI đang đối chiếu ảnh trước và sau..." : "Yêu cầu AI phân xử"}
                </button>
              ) : null}

              {overdue && mineOwner ? (
                <button
                  type="button"
                  disabled={busy === `forfeit-${id}`}
                  onClick={() =>
                    runTx(`forfeit-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "claim_no_return_forfeit", [id])
                    )
                  }
                >
                  {busy === `forfeit-${id}` ? "Đang tịch thu..." : "Quá hạn, nhận toàn bộ cọc"}
                </button>
              ) : null}

              {rental.status === "PAYOUT_FAILED" && (mineOwner || mineRenter) ? (
                <button
                  type="button"
                  disabled={busy === `retry-${id}`}
                  onClick={() =>
                    runTx(`retry-${id}`, () =>
                      writeAndWait(writeClient.writeClient, writeClient.readClient, "retry_resolution", [id])
                    )
                  }
                >
                  {busy === `retry-${id}` ? "Đang thử lại..." : "Thử lại phần chưa trả"}
                </button>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}
