//! Fade — smoothly fade an LED in and out with hardware PWM.
//!
//! Arduino's `analogWrite(5, brightness)`. avr-hal exposes PWM through the
//! `simple_pwm` module: pick a timer, turn an output pin into a PWM pin, then
//! `set_duty(0..=255)`. Wire an LED (+ resistor) from pin D5 to GND.

#![no_std]
#![no_main]

use arduino_hal::simple_pwm::*;
use panic_halt as _;

#[arduino_hal::entry]
fn main() -> ! {
    let dp = arduino_hal::Peripherals::take().unwrap();
    let pins = arduino_hal::pins!(dp);

    let timer0 = Timer0Pwm::new(dp.TC0, Prescaler::Prescale64);
    let mut led = pins.d5.into_output().into_pwm(&timer0);
    led.enable();

    loop {
        for x in (0..=255).chain((0..=254).rev()) {
            led.set_duty(x);
            arduino_hal::delay_ms(10);
        }
    }
}
