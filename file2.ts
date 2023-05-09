import { ISummary } from 'core/b2c/models/flow/checkin/summary';
import { RefundType } from 'core/b2c/integration/domain/fixeds/flow/refund/RefundType';
import { GetStateHelpers } from 'core/b2c/integration/domain/helpers/state-management/GetStateHelpers';
import {
  IRefundOptionsState,
  IRefundOptionsStateOption,
} from 'core/b2c/integration/domain/interfaces/flow/refund-options/IRefundOptionsState';
import { ICommitRefundService } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/commit-refund/ICommitRefundService';
import { IPaymentAddHandler } from 'core/b2c/integration/domain/interfaces/services/internal/payments/IPaymentAddHandler';
import { DispatchHelpers } from 'core/b2c/integration/domain/helpers/state-management/DispatchHelpers';
import { setChangeStatus } from 'core/b2c/store/modules/common/booking/Actions';
import { ActionsPaymentTypes } from 'core/b2c/integration/domain/fixeds/flow/CheckInFlowButtonTypes';
import {
  updateReservationSuccess,
  moveBookingToReservationSuccess,
} from 'core/b2c/store/modules/home/my_trips/Actions';
import { IBookingToReservationConverter } from 'core/b2c/integration/domain/interfaces/converters/my_trips/IBookingToReservationConverter';
import { setStatusPayment } from 'core/b2c/store/modules/common/payment/Actions';
import {
  navigateToNextRoute,
  setAction,
} from 'core/b2c/store/modules/ui/navigator/Actions';
import { PaymentStatus } from 'core/b2c/integration/domain/fixeds/flow/PaymentStatus';
import { IRetrieveBookingService } from 'core/b2c/integration/domain/interfaces/services/external/canonical/v4/IRetrieveBookingService';
import { Booking } from 'core/b2c/models/flow/checkin';
import { FlowNamesAction } from 'core/b2c/integration/domain/fixeds/flow/FlowNamesAction';
import { UnauthorizedError } from 'core/b2c/integration/domain/exceptions/common/UnauthorizedError';
import { ServiceUnavailableError } from 'core/b2c/integration/domain/exceptions/common/ServiceUnavailableError';
import { IRefundService } from 'core/b2c/integration/domain/interfaces/services/external/reservationmanagement/v1/refund/refund/IRefundService';
import { RefundOptionsCardsHelpers } from 'core/b2c/integration/domain/helpers/refund/RefundOptionsCardsHelpers';
import { RefundOptionsCustomerHelpers } from 'core/b2c/integration/domain/helpers/refund/RefundOptionsCustomerHelpers';

export interface IPaymentChangeHandler {
  handle: () => Promise<void>;
}

export class PaymentChangeHandler implements IPaymentChangeHandler {
  private paymentRequest: IPaymentAddHandler;

  private refundRequest: IRefundService;

  private commitService: ICommitRefundService;

  private retrieveBookingService: IRetrieveBookingService;

  private bookingToReservation: IBookingToReservationConverter;

  constructor(
    paymentRequest: IPaymentAddHandler,
    refundRequest: IRefundService,
    commitService: ICommitRefundService,
    retrieveBookingService: IRetrieveBookingService,
    bookingToReservation: IBookingToReservationConverter
  ) {
    this.paymentRequest = paymentRequest;
    this.refundRequest = refundRequest;
    this.commitService = commitService;
    this.retrieveBookingService = retrieveBookingService;
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
        const refundTypeSelected:
          | IRefundOptionsStateOption
          | undefined = options.find((option) => option.isSelected);
        if (!refundTypeSelected) {
          throw new Error('Nenhuma forma de reembolso selecionada.');
        }

        if (refundTypeSelected) {
          if (refundTypeSelected.type === RefundType.CREDIT_SHELL_PNR) {
            DispatchHelpers.dispatch(
              setChangeStatus(ActionsPaymentTypes.CHANGE_CREDIT_PNR_REFUND)
            );
          }

          if (
            refundTypeSelected.type === RefundType.CREDIT_SHELL_CUSTOMER_NUMBER
          ) {
            DispatchHelpers.dispatch(
              setChangeStatus(ActionsPaymentTypes.CHANGE_CREDIT_SHELL_REFUND)
            );
          }

          if (refundTypeSelected.type === RefundType.CREDIT_CARD) {
            DispatchHelpers.dispatch(
              setChangeStatus(
                ActionsPaymentTypes.CHANGE_ORIGINAL_RESERVATION_PAYMENT_METHOD_REFUND
              )
            );
          }

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

        DispatchHelpers.dispatch(
          setChangeStatus(ActionsPaymentTypes.CHANGE_PAYMENT_CONFIRMED)
        );
      }

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

      const newBooking: Booking = await this.retrieveBookingService.handle(
        {
          recordLocator: oldBooking.recordLocator,
          body: {
            departureStation:
              oldBooking.journeys[0].identifier.departureStation,
          },
        },
        {
          selectAll: { journey: true, passenger: true },
          selectByKey: { journey: [], passenger: [] },
        }
      );

      newBooking.refund = oldBooking.refund;

      const moveToReservation = await this.bookingToReservation.handle(
        newBooking
      );
      DispatchHelpers.dispatch(updateReservationSuccess(moveToReservation));
      DispatchHelpers.dispatch(
        moveBookingToReservationSuccess(moveToReservation)
      );

      DispatchHelpers.dispatch(navigateToNextRoute());
    }
  };
}
