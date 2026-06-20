//! Button — read a pushbutton and drive the onboard LED.
//!
//! Arduino's `pinMode(2, INPUT_PULLUP)` + `digitalRead` + `digitalWrite`.
//! Wire a pushbutton between pin D2 and GND; the internal pull-up means the
//! pin reads HIGH when released and LOW when pressed.

#![no_std]
#![no_main]

use panic_halt as _;

#[arduino_hal::entry]
fn main() -> ! {
    let dp = arduino_hal::Peripherals::take().unwrap();
    let pins = arduino_hal::pins!(dp);

    let button = pins.d2.into_pull_up_input();
    let mut led = pins.d13.into_output();

    loop {
        if button.is_low() {
            led.set_high();
        } else {
            led.set_low();
        }
    }
}
