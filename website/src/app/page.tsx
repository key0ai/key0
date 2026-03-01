import Header from "@/components/Header";
import Hero from "@/components/Hero";
import HeroHowItWorksSeparator from "@/components/HeroHowItWorksSeparator";
import HowItWorks from "@/components/HowItWorks";
import ValueProps from "@/components/ValueProps";
import ComingSoon from "@/components/ComingSoon";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <HeroHowItWorksSeparator />
        <HowItWorks />
        <ValueProps />
        <ComingSoon />
      </main>
      <Footer />
    </>
  );
}
