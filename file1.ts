import { ISummary } from 'core/b2c/models/flow/checkin/summary';
import { RefundType } from 'core/b2c/integration/domain/fixeds/flow/refund/RefundType';
import { GetStateHelpers } from 'core/b2c/integration/domain/helpers/state-management/GetStateHelpers';
import { IRefundOptionsState } from 'core/b2c/integration/domain/interfaces/flow/refund-options/IRefundOptionsState';
import { ICommitRefundService } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/commit-refund/ICommitRefundService';
import { IPaymentAddHandler } from 'core/b2c/integration/domain/interfaces/services/internal/payments/IPaymentAddHandler';
import { DispatchHelpers } from 'core/b2c/integration/domain/helpers/state-management/DispatchHelpers';
import { setChangeStatus } from 'core/b2c/store/modules/common/booking/Actions';
import { ActionsPaymentTypes } from 'core/b2c/integration/domain/fixeds/flow/CheckInFlowButtonTypes';
import { updateReservationAndHomeBooking } from 'core/b2c/store/modules/home/my_trips/Actions';
import { setStatusPayment } from 'core/b2c/store/modules/common/payment/Actions';
import {
  navigateToNextRoute,
  setAction,
} from 'core/b2c/store/modules/ui/navigator/Actions';
import { PaymentStatus } from 'core/b2c/integration/domain/fixeds/flow/PaymentStatus';
import { Booking } from 'core/b2c/models/flow/checkin';
import { IChangedService } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/changed/IChangedService';
import { IChangedServiceResponse } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/changed/IChangedServiceResponse';
import { IChangedResponseToIReservationConverter } from 'core/b2c/integration/domain/interfaces/converters/my_trips/IChangedResponseToIReservationConverter';
import { FlowNamesAction } from 'core/b2c/integration/domain/fixeds/flow/FlowNamesAction';
import { ServiceUnavailableError } from 'core/b2c/integration/domain/exceptions/common/ServiceUnavailableError';
import { UnauthorizedError } from 'core/b2c/integration/domain/exceptions/common/UnauthorizedError';
import { IRefundService } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/refund/IRefundService';
import { RefundOptionsCustomerHelpers } from 'core/b2c/integration/domain/helpers/refund/RefundOptionsCustomerHelpers';
import { RefundOptionsCardsHelpers } from 'core/b2c/integration/domain/helpers/refund/RefundOptionsCardsHelpers';

export interface IPaymentCancelHandler {
  handle: () => Promise<void>;
}

export class PaymentCancelHandler implements IPaymentCancelHandler {
  private paymentRequest: IPaymentAddHandler;

  private refundRequest: IRefundService;

  private commitService: ICommitRefundService;

  private changedService: IChangedService;

  private bookingToReservation: IChangedResponseToIReservationConverter;

  private changeStatus: ActionsPaymentTypes =
    ActionsPaymentTypes.CANCEL_NO_VALUE;

  constructor(
    paymentRequest: IPaymentAddHandler,
    refundRequest: IRefundService,
    commitService: ICommitRefundService,
    changedService: IChangedService,
    bookingToReservation: IChangedResponseToIReservationConverter
  ) {
    this.paymentRequest = paymentRequest;
    this.refundRequest = refundRequest;
    this.commitService = commitService;
    this.changedService = changedService;
    this.bookingToReservation = bookingToReservation;
  }

  private setStatusPayment = async (paymentStatus: PaymentStatus) => {
    await new Promise((r) => setTimeout(r, 1500)); // delay para efeito visual

    DispatchHelpers.dispatch(setStatusPayment(paymentStatus));
  };

  handle = async (): Promise<void> => {
    try {
      DispatchHelpers.dispatch(
        setAction(FlowNamesAction.CHANGE_OR_CANCEL_CONFIRMATION_PAGE)
      );

      const { recordLocator } = GetStateHelpers.getState().common.booking;

      const {
        refund,
      }: ISummary = GetStateHelpers.getState().common.pages.summary;

      const {
        options,
        loyaltyProgramUsers,
      }: IRefundOptionsState = GetStateHelpers.getState().common.pages.refundOptions;

      if (refund?.hasAmountToRefund) {
        const refundTypeSelected = options.find((option) => option.isSelected);

        if (!refundTypeSelected) {
          throw new Error('Nenhuma forma de reembolso selecionada.');
        }

        if (refundTypeSelected) {
          if (refundTypeSelected.type === RefundType.CREDIT_SHELL_PNR) {
            this.changeStatus = ActionsPaymentTypes.CANCEL_CREDIT_PNR_REFUND;
          }

          if (
            refundTypeSelected.type === RefundType.CREDIT_SHELL_CUSTOMER_NUMBER
          ) {
            this.changeStatus = ActionsPaymentTypes.CANCEL_CREDIT_SHELL_REFUND;
          }

          if (refundTypeSelected.type === RefundType.CREDIT_CARD) {
            this.changeStatus =
              ActionsPaymentTypes.CANCEL_ORIGINAL_RESERVATION_PAYMENT_METHOD_REFUND;
          }

          // status de reembolso processando
          await this.setStatusPayment(PaymentStatus.REFUND_PENDING);
          await this.refundRequest.handle({
            recordLocator,
            refund: refundTypeSelected.type,
            customerNumber: RefundOptionsCustomerHelpers.getCustomerNumberByRefundOption(
              refundTypeSelected,
              loyaltyProgramUsers
            ),
            cards: RefundOptionsCardsHelpers.getCardsToRefund(
              refundTypeSelected.cards
            ),
          });
          await this.setStatusPayment(PaymentStatus.APPROVED);
        }
      }

      if (refund?.hasAmountToPay) {
        await this.setStatusPayment(PaymentStatus.PENDING);
        await this.paymentRequest.handle();
        await this.setStatusPayment(PaymentStatus.APPROVED);
      }

      if (!refund?.hasAmountToPay && !refund?.hasAmountToRefund) {
        this.changeStatus = ActionsPaymentTypes.CANCEL_NO_VALUE;
      }

      DispatchHelpers.dispatch(setChangeStatus(this.changeStatus));

      await this.commitService.handle({
        recordLocator,
      });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await this.setStatusPayment(PaymentStatus.INTERNAL_SERVER_ERROR);
        return;
      }
      if (error instanceof ServiceUnavailableError) {
        await this.setStatusPayment(PaymentStatus.INTERNAL_SERVER_ERROR);
        return;
      }

      await this.setStatusPayment(PaymentStatus.DECLINED);
    } finally {
      const oldBooking = GetStateHelpers.getState().common.booking as Booking;

      const changed: IChangedServiceResponse = await this.changedService.handle(
        {
          recordLocator: oldBooking.recordLocator,
        }
      );

      const moveToReservation = await this.bookingToReservation.handle(changed);

      DispatchHelpers.dispatch(
        updateReservationAndHomeBooking(moveToReservation)
      );

      DispatchHelpers.dispatch(navigateToNextRoute());
    }
  };
}
