"""Payment UI adapter: commands request UI actions; only UI reports outcomes."""
from copy import deepcopy
from uuid import uuid4
from .domain import OrderError
from .language import translate, formatted

METHODS = {'card': '신용·체크카드', 'samsung': '삼성페이', 'apple': '애플페이', 'kakao': '카카오페이', 'naver': '네이버페이'}
STATUSES = {'waiting', 'reading', 'processing', 'approved', 'failure', 'timeout'}


def sync_payment(store, cart, total):
    payment, receipt = cart.get('payment'), cart.get('receipt')
    if payment is not None:
        if not isinstance(payment, dict) or payment.get('method') not in METHODS or payment.get('status') not in STATUSES or not isinstance(payment.get('attempt'), str) or not payment['attempt']:
            raise OrderError('결제 진행 정보를 확인해 주세요.')
        if cart['screen'] != 'payment':
            raise OrderError('결제 화면과 진행 상태가 맞지 않아요.')
    if receipt is not None:
        if not isinstance(receipt, dict) or receipt.get('method') not in METHODS or receipt.get('total') != total or not isinstance(receipt.get('id'), str) or not receipt['id'] or not isinstance(receipt.get('number'), str) or not receipt['number'] or cart['screen'] not in {'finalizing', 'completed'}:
            raise OrderError('완료된 주문 정보를 확인해 주세요.')
    elif cart['screen'] in {'finalizing', 'completed'}:
        raise OrderError('주문 완료 결과가 필요해요.')
    return {'payment': deepcopy(payment), 'receipt': deepcopy(receipt), 'screen': cart['screen']}


def command(store, kind, method=None):
    if store.phase != 'checkout':
        raise OrderError('주문 내용을 확인하고 결제수단 선택 화면으로 먼저 이동해 주세요.')
    current = store.payment_ui.get('payment')
    status = current and current['status']
    if status == 'approved' or store.payment_ui.get('receipt'):
        raise OrderError('이미 승인된 결제는 다시 시작하거나 취소하지 않아요.')
    if kind == 'select':
        if method not in METHODS:
            raise OrderError('화면에 있는 결제수단을 선택해 주세요.')
        if status in {'reading', 'processing'}:
            raise OrderError('결제가 진행 중이에요. 결과를 기다리거나 먼저 취소해 주세요.')
    elif kind == 'retry':
        if status not in {'failure', 'timeout'}:
            raise OrderError('실패하거나 시간이 초과된 결제만 다시 시도할 수 있어요.')
        method = current['method']
    elif kind == 'cancel':
        if current is None:
            raise OrderError('진행 중인 결제가 없어요. 결제수단을 선택해 주세요.')
    else:
        raise OrderError('지원하지 않는 결제 동작이에요.')
    if store.payment_action:
        # Same tool call retries must not start another reader attempt.
        old = store.payment_action
        if old['kind'] == kind and old['method'] == method:
            return old
        raise OrderError('앞선 결제 화면 동작을 반영한 뒤 다시 요청해 주세요.')
    store.payment_action = {'id': uuid4().hex, 'kind': kind, 'method': method,
                            'expected_attempt': current['attempt'] if current else None,
                            'total': store.snapshot()['total']}
    return deepcopy(store.payment_action)


def notice(store):
    receipt = store.payment_ui.get('receipt')
    if receipt:
        return formatted(store.language, "결제가 완료됐어요. 주문번호는 {number}번이에요. 맛있게 드세요!", number=receipt["number"])
    payment = store.payment_ui.get('payment')
    if payment and payment['status'] == 'failure':
        return translate(store.language, '결제가 승인되지 않았어요. 같은 결제수단으로 다시 시도할까요?')
    if payment and payment['status'] == 'timeout':
        return translate(store.language, '결제 시간이 지났어요. 같은 결제수단으로 다시 시도할까요?')
    raise OrderError('안내할 새로운 결제 결과가 없어요.')
