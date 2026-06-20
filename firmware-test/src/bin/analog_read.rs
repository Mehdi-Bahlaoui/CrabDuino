//! Analog Read Serial — read an analog pin and print it over serial.
//!
//! Arduino's `analogRead(A0)` + `Serial.begin`/`Serial.println`. Open the
//! console (Upload does this automatically) to watch the values; wire a
//! potentiometer's wiper to A0 to see them change.

#![no_std]
#![no_main]

use arduino_hal::prelude::*;
use panic_halt as _;

#[arduino_hal::entry]
fn main() -> ! {
    let dp = arduino_hal::Peripherals::take().unwrap();
    let pins = arduino_hal::pins!(dp);
    let mut serial = arduino_hal::default_serial!(dp, pins, 57600);
    let mut adc = arduino_hal::Adc::new(dp.ADC, Default::default());

    let a0 = pins.a0.into_analog_input(&mut adc);

    loop {
        let value = a0.analog_read(&mut adc);
        ufmt::uwriteln!(&mut serial, "A0: {}", value).unwrap_infallible();
        arduino_hal::delay_ms(500);
    }
}
