import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/scheduler";
admin.initializeApp();

const db = admin.firestore();

interface Passenger {
  userId?: string;
  firstname: string;
  lastname: string;
  phoneNumber: string;
  isCheckedIn: boolean;
  paymentAmount: string;
  baggageSize: string;
  bookedSeat: string;
  nextOfKin: NextOfKinModel;
  createdDate: Date;
  modifiedDate: Date;
  createdBy: string;
  modifiedBy: string;
  pickupLocation: string;
  bookingNumber: string;
}

interface NextOfKinModel {
  id?: string;
  firstname?: string;
  lastname?: string;
  phonenumber?: string;
  createdDate?: Date;
  modifiedDate?: Date;
  createdBy?: string;
  modifiedBy?: string;
}

interface Seat {
  number: number;
  booked: boolean;
  bookedBy: string;
}

async function archiveLogic() {
  const now = new Date();
  const oneMonthAgo = new Date(now);
  oneMonthAgo.setMonth(now.getMonth() - 1);

  const activeBookingsSnapshot = await db
    .collection("bookings")
    .where("status", "==", "Active")
    .get();

  const batch = db.batch();
  let count = 0;

  activeBookingsSnapshot.forEach((doc) => {
    const data = doc.data();
    const departureDateStr = data.departureDate;

    if (departureDateStr) {
      const departureDate = new Date(departureDateStr);
      if (!isNaN(departureDate.getTime()) && departureDate < oneMonthAgo) {
        batch.update(doc.ref, { status: "Archived" });
        count++;
      }
    }
  });

  if (count > 0) {
    await batch.commit();
    console.log(`${count} bookings archived.`);
  } else {
    console.log("No bookings to archive.");
  }
}

export const archiveOldBookingsRequest = functions.https.onRequest(
  async (req, res): Promise<void> => {
    // Check if the request is a POST
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      await archiveLogic();
      res.status(200).send("Old bookings archived successfully");
      return;
    } catch (error) {
      console.error("Error processing trips:", error);
      res.status(500).send("Internal Server Error");
    }
  }
);

export const archiveOldBookings = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Africa/Lagos",
  },
  async () => {
    await archiveLogic();

    return;
  }
);

export const onVehicleUpdate = functions.firestore.onDocumentUpdated(
  "vehicles/{vehicleId}",
  async (event) => {
    const vehicleId = event.params.vehicleId;
    const change = event.data;

    // Get the updated vehicle document
    const updatedVehicle = change?.after.data();

    if (!updatedVehicle) {
      console.error("Vehicle document not found");
      return;
    }

    try {
      // Wait for 3 minutes before running the function logic
      await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1000));

      // Fetch trips with the vehicleId
      const tripsSnapshot = await db
        .collection("trips")
        .where("vehicleId", "==", vehicleId)
        .get();

      if (tripsSnapshot.size > 1) {
        console.log("Multiple trips found. Terminating process.", vehicleId);
        return;
      }

      if (tripsSnapshot.size === 0) {
        console.log("No trip found for the vehicle.");
        return;
      }

      // Get the single trip document
      const tripDoc = tripsSnapshot.docs[0];
      const trip = tripDoc.data();
      const tripId = trip.id;

      // Fetch bookings for the trip
      const bookingsSnapshot = await db
        .collection("bookings")
        .where("tripId", "==", tripId)
        .get();

      const bookings = bookingsSnapshot.docs.map((doc) => doc.data());

      // Extract all passenger booking numbers from bookings
      const bookingPassengerIds = bookings.flatMap(
        (booking) => booking.bookingNumber
      );

      // Extract all passenger booking numbers from the trip
      const tripPassengerIds = trip.passengers.map(
        (passenger: Passenger) => passenger.bookingNumber
      );

      // Check if all booking passengers are in the trip
      const unmatchedBookingPassengers = bookingPassengerIds.filter(
        (id) => !tripPassengerIds.includes(id)
      );

      if (unmatchedBookingPassengers.length > 0) {
        console.warn(
          "Some bookings contain passengers not in the trip:",
          unmatchedBookingPassengers
        );
        return;
      }

      // Compare the passengers in the trip with the vehicle's seats
      const bookedSeats = trip.passengers.map(
        (passenger: Passenger) => passenger.bookedSeat
      );
      const vehicleSeats = updatedVehicle.seats;

      // Check for invalid booked seats that are marked as booked but not used by passengers
      const invalidBookedSeats = vehicleSeats.filter(
        (seat: Seat) =>
          seat.booked && !bookedSeats.includes(seat.number.toString())
      );

      if (invalidBookedSeats.length > 0) {
        console.log(
          "Resetting invalid booked seats:",
          invalidBookedSeats,
          vehicleId
        );

        // Use a Firestore batch to reset invalid seats
        const batch = db.batch();

        // Update the vehicle document in a batch operation
        const updatedSeats = vehicleSeats.map((seat: Seat) => {
          if (
            invalidBookedSeats.some(
              (invalidSeat: Seat) => invalidSeat.number === seat.number
            )
          ) {
            return { ...seat, booked: false, bookedBy: "" }; // Reset invalid seat
          }
          return seat;
        });

        const vehicleDocRef = db.collection("vehicles").doc(vehicleId);
        batch.update(vehicleDocRef, {
          seats: updatedSeats,
        });

        // Commit the batch
        await batch.commit();
        console.log("Invalid booked seats reset successfully.");
      } else {
        // This message will only run if there are no invalid seats
        console.log("All booked seats are valid.");
      }
    } catch (error) {
      console.error("Error processing vehicle update:", error);
    }
  }
);

export const resetSeatsForTrips = functions.https.onRequest(
  async (req, res): Promise<void> => {
    // Check if the request is a POST
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      // Fetch all active trips
      const tripsSnapshot = await db
        .collection("trips")
        .where("status", "==", "Booking")
        .get();

      console.log(tripsSnapshot);

      if (tripsSnapshot.empty) {
        res.status(404).send("No trips found in the specified date range.");
        return;
      }

      // Iterate through each trip
      for (const tripDoc of tripsSnapshot.docs) {
        const trip = tripDoc.data();
        const tripId = trip.id;

        // Fetch bookings for the trip
        const bookingsSnapshot = await db
          .collection("bookings")
          .where("tripId", "==", tripId)
          .get();

        const vehicleSnapshot = await db
          .collection("vehicles")
          .where("id", "==", trip.vehicleId)
          .get();

        const bookings = bookingsSnapshot.docs.map((doc) => doc.data());
        const vehicleDoc = vehicleSnapshot.docs[0];
        const vehicle = vehicleDoc.data();

        // Extract all passenger booking numbers from bookings
        const bookingPassengerIds = bookings.flatMap(
          (booking) => booking.bookingNumber
        );

        // Extract all passenger booking numbers from the trip
        const tripPassengerIds = trip.passengers.map(
          (passenger: Passenger) => passenger.bookingNumber
        );

        // Check if all booking passengers are in the trip
        const unmatchedBookingPassengers = bookingPassengerIds.filter(
          (id) => !tripPassengerIds.includes(id)
        );

        if (unmatchedBookingPassengers.length > 0) {
          // Log details of the unmatched bookings instead of returning
          unmatchedBookingPassengers.forEach((bookingNumber) => {
            const unmatchedBooking = bookings.find(
              (booking) => booking.bookingNumber === bookingNumber
            );
            if (unmatchedBooking) {
              console.warn(
                `Booking with ID ${unmatchedBooking.bookingNumber} is not part of the trip. Details:`,
                unmatchedBooking
              );
            }
          });
          // Skip this trip and continue with the next trip
          continue;
        }

        // Compare the passengers in the trip with the vehicle's seats
        const bookedSeats = trip.passengers.map(
          (passenger: Passenger) => passenger.bookedSeat
        );
        const vehicleSeats = vehicle.seats;

        // Check for invalid booked seats that are marked as booked but not used by passengers
        const invalidBookedSeats = vehicleSeats.filter(
          (seat: Seat) =>
            seat.booked && !bookedSeats.includes(seat.number.toString())
        );

        if (invalidBookedSeats.length > 0) {
          console.log("Resetting invalid booked seats:", invalidBookedSeats);

          // Use a Firestore batch to reset invalid seats
          const batch = db.batch();

          // Update the vehicle document in a batch operation
          const updatedSeats = vehicleSeats.map((seat: Seat) => {
            if (
              invalidBookedSeats.some(
                (invalidSeat: Seat) => invalidSeat.number === seat.number
              )
            ) {
              return { ...seat, booked: false, bookedBy: "" }; // Reset invalid seat
            }
            return seat;
          });

          const vehicleDocRef = db.collection("vehicles").doc(trip.vehicleId);
          batch.update(vehicleDocRef, {
            seats: updatedSeats,
          });

          // Commit the batch
          await batch.commit();
          console.log("Invalid booked seats reset successfully.");
        } else {
          // This message will only run if there are no invalid seats
          console.log("All booked seats are valid.");
        }
      }

      // Respond with success
      res
        .status(200)
        .send("Seats reset successfully for the trips in the date range.");
      return;
    } catch (error) {
      console.error("Error processing trips:", error);
      res.status(500).send("Internal Server Error");
    }
  }
);
