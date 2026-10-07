# ToolGuard

Escrow cọc thuê thiết bị ngắn hạn trên GenLayer. Hai cá nhân tự thỏa thuận mức bồi thường cố định. Owner nộp bằng chứng tình trạng trước khi giao, renter nộp bằng chứng lúc trả. Contract giữ GEN và chỉ giải ngân sau phán quyết nhị phân `NO_DAMAGE` hoặc `DAMAGED`.

> ToolGuard chết nếu không có GenLayer: không có smart contract EVM nào đọc hiểu được ảnh tình trạng thiết bị phi cấu trúc để đối chiếu trước/sau, và không có bên trung gian nào đủ rẻ để phân xử hàng loạt lượt thuê đồ nhỏ lẻ giữa cá nhân — chỉ có đồng thuận AI phi tập trung của GenLayer mới làm được với chi phí gần bằng 0.

## Bài toán

Cho thuê máy khoan, xe đạp, máy ảnh, đồ cắm trại giữa cá nhân hay kẹt ở câu hỏi lúc trả đồ: hỏng từ trước hay hỏng trong lúc thuê. Một trọng tài người cho từng lượt thuê nhỏ là quá đắt.

ToolGuard giữ tiền cọc trong một intelligent contract:

1. Renter tạo đơn, gửi GEN làm cọc, ghi địa chỉ owner, mô tả thiết bị, mức bồi thường cố định nếu hỏng, và hạn trả.
2. Owner nộp link bằng chứng trước khi giao. Trạng thái chuyển sang `RENTED`.
3. Renter nộp link bằng chứng lúc trả.
4. `resolve_rental` fetch hai bộ bằng chứng, hỏi AI, và validator chỉ chấp nhận khi cùng một verdict nhị phân.
5. `NO_DAMAGE`: renter nhận lại đủ cọc. `DAMAGED`: owner nhận đúng số đã thỏa thuận, renter nhận phần còn lại.
6. Confidence dưới 60 thành `DISPUTED`. Renter được nộp bằng chứng khác rồi phân xử lại.
7. Nếu quá hạn mà renter không báo trả, owner gọi `claim_no_return_forfeit` và nhận toàn bộ cọc. Nhánh này không gọi AI.

## Giới hạn trung thực

Lĩnh vực thuê đồ cá nhân không có nguồn thứ ba công khai kiểu tracking, hãng bảo hiểm hay cơ quan quản lý. Contract không kiểm tra được một sổ cái độc lập của thiết bị.

Cơ chế đối chiếu là hai bên nộp bằng chứng ở hai thời điểm khác nhau: owner nộp trước khi giao, renter nộp sau khi trả. Không bên nào một mình kiểm soát cả hai bộ. Đó là một dạng độc lập thực tế, không phải nguồn thứ ba chính thống, và không phải chống gian lận tuyệt đối. Hai bên vẫn có thể cùng đưa ảnh không trung thực.

`reference_urls` chỉ là bằng chứng bổ sung, có thể bỏ trống. Lỗi khi tải các URL này được bỏ qua. URL tình trạng trước và sau bắt buộc phải tải được.

Verdict chỉ có hai giá trị. Mức bồi thường khi `DAMAGED` là số cố định hai bên chọn lúc tạo đơn, không phải phần trăm do AI tính. Validator so đúng chuỗi verdict, không có dung sai.

## Kiến trúc

Một contract `contracts/toolguard.py`, class `ToolGuard`, giữ GEN trực tiếp. Header runner:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

API đã khóa theo Studio hiện hành:

- Người gọi: `gl.message.sender_address`
- GEN gửi kèm: `gl.message.value` trên `@gl.public.write.payable`. Studio từ chối value khác 0 nếu method chỉ là `@gl.public.write`.
- Trả GEN: `gl.get_contract_at(address).emit_transfer(value=u256(amount))`
- Thời gian: `gl.message.datetime` đổi sang Unix giây bằng `datetime`
- Không dùng `gl.transfer`, `gl.message.sender`, hay `gl.block.timestamp`

`retry_resolution` chỉ chuyển phía còn `owner_paid == False` hoặc `renter_refunded == False`. Cờ đã True không bị xóa và không bị chuyển lại.

## Bảng xử lý tiền

Mọi số tiền là số nguyên wei. 1 GEN = 10^18 wei. Không có `float` trong contract và không có `parseFloat`, `Math.round`, `Math.floor`, `Math.ceil` cạnh biến tiền ở frontend.

| Chỗ | Input | Phép tính | Output |
| --- | --- | --- | --- |
| `create_rental` | `gl.message.value` trên method payable | `bigint(int(value))`, chặn `<= 0` | `deposit_amount` |
| `create_rental` | `damaged_payout_to_owner` | chặn `<= 0` hoặc `>= deposit` | lưu nguyên số đã thỏa thuận |
| `NO_DAMAGE` | `deposit_amount` | một lần `emit_transfer` cho renter | renter nhận đủ cọc, `renter_refunded` |
| `DAMAGED` owner | `damaged_payout_to_owner` | một lần `emit_transfer` nếu `owner_paid` còn false | owner nhận đúng mức cố định |
| `DAMAGED` renter | `deposit_amount - damaged_payout_to_owner` | trừ bigint, `emit_transfer` nếu `renter_refunded` còn false | renter nhận phần chênh |
| Quá hạn | `deposit_amount` | `emit_transfer` toàn bộ cho owner, không gọi AI | `EXPIRED_FORFEITED`, `owner_paid` |
| `retry_resolution` | hai cờ bool | chỉ gọi transfer cho cờ còn false | không trả trùng |
| `parseGenToWei` | chuỗi GEN | tách phần nguyên/thập phân, pad 18 chữ số, `BigInt` | wei |
| `formatWeiToGen` | wei | chia và mod `10^18` bằng `BigInt` | chuỗi GEN |
| `payoutWeiFromPercent` | cọc wei và số nguyên 10/25/50/75 | `(deposit * percent) / 100n`, bỏ kết quả không thỏa `0 < x < deposit` | gợi ý mức bồi thường |
| `subtractWei` | hai wei | trừ `BigInt` | preview phần hoàn |
| `deadlineUnix` | số ngày | giây Unix, không phải tiền | `rental_end_deadline` |

`frontend/scripts/check-no-float-money.cjs` quét `frontend/src/**/*.{js,jsx}` và fail nếu `parseFloat`, `Math.round`, `Math.floor` hoặc `Math.ceil` đứng gần biến tiền. Script gắn vào `prebuild` để Vercel chạy được khi root là `frontend`. `scripts/check-no-float-money.js` ở gốc repo gọi lại cùng file đó.

## Test

```bash
pip install -r requirements.txt
python -m pytest tests/test_toolguard.py -q
```

Trước mỗi giao dịch nondet, test gọi `sim_install_mocks` để gắn mock web/LLM. Suite gồm happy path hai verdict, tịch thu quá hạn, chặn báo trả khi chưa giao, confidence thấp rồi nộp lại, web/JSON hỏng, reference URL lỗi vẫn resolve, payout cấu hình sai, double-resolve, và transfer fail từng nhánh (`NO_DAMAGE`, `DAMAGED` chỉ owner, chỉ renter, cả hai, forfeit) rồi retry không trả trùng.

## Frontend

App Vite nằm trong `frontend/`. Chain khóa `studionet`. `VITE_CONTRACT_ADDRESS` nằm trong `frontend/.env.production`. Nếu biến này trống, trang vẫn mở, có banner, và không gửi giao dịch.

```bash
cd frontend
npm install
npm run dev
```

GitHub: `https://github.com/nhattung99/tool-guard-genlayer.git`. Vercel project `tool-guard-genlayer` trên tài khoản cũ, root directory là `frontend`. Địa chỉ contract nằm trong `frontend/.env.production`.

## Deploy contract trên studionet

Việc deploy contract là tay, trên [studio.genlayer.com](https://studio.genlayer.com), mạng studionet. Không đổi sang testnet.

1. Mở Studio, chọn studionet.
2. Dán `contracts/toolguard.py`. Constructor không nhận tham số.
3. Deploy và đợi `Result: SUCCESS`.
4. Địa chỉ đã deploy được ghi trong `frontend/.env.production`.

### Địa chỉ contract

`0x245e06222E1221977cc9E235E11ED98aF6D47855`

[Explorer studionet](https://explorer-studio.genlayer.com/address/0x245e06222E1221977cc9E235E11ED98aF6D47855)

## Known issue

`emit_transfer` xếp một message và có thể ném lỗi ngay (value bằng 0, số dư không đủ, lời gọi bị từ chối). Những lỗi đó vào `PAYOUT_FAILED` và `retry_resolution` chỉ trả phía còn thiếu.

Nếu message con fail sau khi transaction cha đã được chấp nhận, cờ đã nhận có thể là True trong khi ví đích chưa thấy tiền. Đó là cách message của GenLayer hoạt động. Retry không đụng phía đã đánh dấu thành công, nên không trả trùng, nhưng cũng không tự biết message con fail muộn.
